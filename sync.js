/* Zoebas Taakplanner -> club.basketball.nl (Foys API)
 *
 * Wordt geladen via de bookmarklet uit de taakplanner (Instellingen -> Koppeling basketball.nl),
 * terwijl je ingelogd bent op club.basketball.nl. Het script:
 *   1. leest de indeling uit Supabase (app_state),
 *   2. vergelijkt per thuiswedstrijd in een gepubliceerde week met de officials op basketball.nl,
 *   3. toont een droge run en schrijft pas na "Doorvoeren",
 *   4. controleert daarna opnieuw en legt het resultaat vast in sync_log.
 * Daarnaast: spelers/teamindeling uit basketball.nl lezen en bondsnummer + NBB-teams aanvullen.
 *
 * Het toegangstoken van de clubbeheer-sessie wordt alleen in het geheugen gebruikt: nooit gelogd of opgeslagen.
 */
(function (root) {
  'use strict';

  /* ===================== Configuratie ===================== */
  const CFG = {
    org: 'f7729ca8-4e22-4ae3-bede-6e36c2f507eb',
    api: 'https://api.foys.io',
    supabaseUrl: 'https://ezzynaqeplbxrdvebphx.supabase.co',
    supabaseKey: 'sb_publishable_kSW3nWA4nO2y2FlPY7Mupg_ZNqhQ-kT',
    pauseMs: 250,
  };
  // Taakplanner-slot -> officialRoleId op basketball.nl
  const ROLE_OF_SLOT = { scheidsrechter1: 25, scheidsrechter2: 25, jury1: 19, jury2: 20, jury3: 21 };
  const ROLE_NAME = { 25: 'Scheidsrechter club', 19: 'Scorer', 20: 'Timer', 21: 'Schotklok operator' };
  const SLOT_LABEL = { scheidsrechter1: 'Scheidsrechter 1', scheidsrechter2: 'Scheidsrechter 2', jury1: 'Scorer', jury2: 'Timer', jury3: 'Schotklok' };

  /* ===================== Pure hulpfuncties (ook getest in Node) ===================== */
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function fullName(p) {
    if (!p) return '';
    const parts = [p.voornaam, p.tussenvoegsel, p.achternaam].map(x => String(x || '').trim()).filter(Boolean);
    return parts.length ? parts.join(' ') : String(p.name || '');
  }
  function memberName(m) {
    if (!m) return '';
    const parts = [m.firstName, m.nameInfix, m.lastName].map(x => String(x || '').trim()).filter(Boolean);
    return m.fullName || parts.join(' ');
  }
  function nameMatches(member, wanted) {
    const w = norm(wanted);
    if (!w) return false;
    if (norm(member.fullName) === w) return true;
    const parts = [member.firstName, member.nameInfix, member.lastName].map(x => String(x || '').trim()).filter(Boolean);
    return parts.length > 0 && norm(parts.join(' ')) === w;
  }
  function splitName(full) {
    full = String(full || '').trim().replace(/\s+/g, ' ');
    if (!full) return { voornaam: '', tussenvoegsel: '', achternaam: '' };
    const parts = full.split(' ');
    if (parts.length === 1) return { voornaam: parts[0], tussenvoegsel: '', achternaam: '' };
    const tuss = ['de', 'van', 'der', 'den', 'ten', 'ter', 'het', 'op', "'t", 'in', "'s"];
    const voornaam = parts.shift(); const tv = [];
    while (parts.length > 1 && tuss.includes(parts[0].toLowerCase())) tv.push(parts.shift());
    return { voornaam, tussenvoegsel: tv.join(' '), achternaam: parts.join(' ') };
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoLocal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function mondayOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return isoLocal(d);
  }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function asItems(x) { return Array.isArray(x) ? x : (x && Array.isArray(x.items) ? x.items : []); }
  function bnOf(person) { return person && person.federationMembershipIdentifier ? String(person.federationMembershipIdentifier) : null; }
  function rowCurrent(row) {
    // Een rij zonder persoon is leeg, ook als hij (fout uit het verleden) op Planned staat
    if (!row || !row.person) return null;
    return { bn: bnOf(row.person), name: row.person.fullName || memberName(row.person) };
  }

  /* Wedstrijden die gesynct moeten worden: thuis, in een gekozen gepubliceerde week, (optioneel) niet verleden */
  function selectMatches(data, opts) {
    const weeks = new Set(opts.weeks || []);
    const today = opts.today;
    return (data.wedstrijden || [])
      .filter(m => !m.away && m.date && weeks.has(mondayOf(m.date)))
      .filter(m => opts.includePast || m.date >= today)
      .sort((a, b) => (a.date + ' ' + (a.time || '')).localeCompare(b.date + ' ' + (b.time || '')));
  }

  /* Gewenste slots voor \u00e9\u00e9n wedstrijd */
  function desiredSlots(match, indeling) {
    const asg = (indeling && indeling[match.id]) || {};
    const slots = ['scheidsrechter1', 'scheidsrechter2', 'jury1', 'jury2'];
    if (match.extra24 || asg.jury3) slots.push('jury3');
    return slots.map(slot => ({ slot, roleId: ROLE_OF_SLOT[slot], pid: asg[slot] || null }));
  }

  /* Persoon-index van de taakplanner (spelers + poule) */
  function buildPeople(data) {
    const byId = {};
    (data.spelers || []).forEach(p => { byId[p.id] = p; });
    (data.poule || []).forEach(p => { if (!byId[p.id]) byId[p.id] = p; });
    const knownBns = new Set(); const knownNames = new Set();
    Object.values(byId).forEach(p => { if (p.nbbId) knownBns.add(String(p.nbbId)); const n = norm(fullName(p)); if (n) knownNames.add(n); });
    return { byId, knownBns, knownNames };
  }

  /* Plan voor \u00e9\u00e9n wedstrijd: per rol de gewenste personen tegen de bestaande rijen leggen.
     slots: [{slot, roleId, pid, name, bn, unresolved, warn}]
     rows: Foys match-official rijen
     ctx: { allowClear, syncFilled:Set('rowId|bn'), people } */
  function planMatch(slots, rows, ctx) {
    const ops = []; const warnings = [];
    const roleIds = [...new Set(slots.map(s => s.roleId))];
    roleIds.forEach(roleId => {
      const D = slots.filter(s => s.roleId === roleId);
      let R = rows.filter(r => Number(r.officialRoleId) === roleId).slice().sort((a, b) => a.id - b.id);
      if (!R.length) {
        if (D.some(d => d.pid)) D.filter(d => d.pid).forEach(d => ops.push({ type: 'overslaan', slot: d.slot, roleId, row: null, want: d, cur: null, warn: 'Rol ' + ROLE_NAME[roleId] + ' ontbreekt bij deze wedstrijd op basketball.nl' }));
        else D.forEach(d => ops.push({ type: 'gelijk', slot: d.slot, roleId, row: null, want: d, cur: null, note: 'rol niet aanwezig, niets ingedeeld' }));
        return;
      }
      const take = row => { R = R.filter(r => r !== row); return row; };
      const pending = [];
      // 1. Al goed (zelfde bondsnummer)
      D.forEach(d => {
        if (d.pid && d.bn) {
          const row = R.find(r => { const c = rowCurrent(r); return c && c.bn === d.bn; });
          if (row) { take(row); ops.push({ type: 'gelijk', slot: d.slot, roleId, row, want: d, cur: rowCurrent(row) }); return; }
        }
        pending.push(d);
      });
      // 2. Bondsnummer onbekend maar de naam staat er al
      const pending2 = [];
      pending.forEach(d => {
        if (d.pid && !d.bn) {
          const row = R.find(r => { const c = rowCurrent(r); return c && norm(c.name) === norm(d.name); });
          if (row) { take(row); ops.push({ type: 'gelijk', slot: d.slot, roleId, row, want: d, cur: rowCurrent(row), warn: d.warn || 'bondsnummer onbekend; naam staat er al' }); return; }
        }
        pending2.push(d);
      });
      const canTouch = (row, cur) => {
        if (ctx.syncFilled && ctx.syncFilled.has(row.id + '|' + cur.bn)) return true;
        if (cur.bn && ctx.people.knownBns.has(cur.bn)) return true;
        return ctx.people.knownNames.has(norm(cur.name));
      };
      // 3. Toevoegen / vervangen
      const emptyFirst = () => { const e = R.find(r => !rowCurrent(r)); return e || R[0]; };
      pending2.filter(d => d.pid && d.bn).forEach(d => {
        const row = emptyFirst();
        if (!row) { ops.push({ type: 'overslaan', slot: d.slot, roleId, row: null, want: d, cur: null, warn: 'geen vrije rij ' + ROLE_NAME[roleId] + ' op basketball.nl' }); return; }
        take(row); const cur = rowCurrent(row);
        if (!cur) ops.push({ type: 'toevoegen', slot: d.slot, roleId, row, want: d, cur: null, warn: d.warn });
        else if (canTouch(row, cur)) ops.push({ type: 'vervangen', slot: d.slot, roleId, row, want: d, cur, warn: d.warn });
        else ops.push({ type: 'overslaan', slot: d.slot, roleId, row, want: d, cur, warn: 'huidige persoon is niet door de taakplanner gezet \u2014 handmatig controleren' });
      });
      // 4. Persoon niet te koppelen aan een bondsnummer -> melden, niets schrijven
      pending2.filter(d => d.pid && !d.bn).forEach(d => {
        const row = R.find(r => rowCurrent(r)) || R[0] || null;
        if (row) take(row);
        ops.push({ type: 'overslaan', slot: d.slot, roleId, row, want: d, cur: rowCurrent(row), warn: d.warn || 'bondsnummer onbekend' });
      });
      // 5. Leeg in de planner
      const emptySlots = pending2.filter(d => !d.pid);
      R.slice().forEach(row => {
        const d = emptySlots.shift() || { slot: null, roleId, pid: null };
        take(row); const cur = rowCurrent(row);
        if (!cur) { ops.push({ type: 'gelijk', slot: d.slot, roleId, row, want: d, cur: null }); return; }
        if (!canTouch(row, cur)) { ops.push({ type: 'overslaan', slot: d.slot, roleId, row, want: d, cur, warn: 'leeg in planner, maar huidige persoon is niet door de taakplanner gezet' }); return; }
        if (!ctx.allowClear) { ops.push({ type: 'overslaan', slot: d.slot, roleId, row, want: d, cur, warn: 'leeg in planner \u2014 leegmaken staat uit' }); return; }
        ops.push({ type: 'leegmaken', slot: d.slot, roleId, row, want: d, cur });
      });
      emptySlots.forEach(d => ops.push({ type: 'gelijk', slot: d.slot, roleId, row: null, want: d, cur: null, note: 'geen rij, niets ingedeeld' }));
    });
    const order = { scheidsrechter1: 1, scheidsrechter2: 2, jury1: 3, jury2: 4, jury3: 5 };
    ops.sort((a, b) => (order[a.slot] || 9) - (order[b.slot] || 9));
    return { ops, warnings };
  }

  function putBody(row, matchId, bn) {
    const clear = !bn;
    return {
      status: clear ? 'Draft' : 'Planned',
      assignedBy: 'Club',
      note: row.note == null ? null : row.note,
      officialRoleId: row.officialRoleId,
      officialRoleName: row.officialRoleName || ROLE_NAME[row.officialRoleId] || null,
      absenceReasonId: null, absenceReason: null, absenceReasonDescription: null,
      personId: null, person: null,
      id: row.id,
      federationMembershipIdentifier: clear ? null : String(bn),
      matchId: Number(matchId),
    };
  }

  /* Spelersimport: NBB-teamleden tegen de spelers leggen. Alleen nbbId en nbbTeams veranderen. */
  function planPlayerImport(spelers, members) {
    // members: [{bn, fullName, firstName?, nameInfix?, lastName?, teams:[..]}]
    const byBn = {}; const byName = {};
    spelers.forEach(p => {
      if (p.nbbId) byBn[String(p.nbbId)] = p;
      const n = norm(fullName(p)); if (n) (byName[n] = byName[n] || []).push(p);
    });
    const assigned = {}; // spelerId -> member
    const nieuw = []; const dubbel = []; const conflict = [];
    members.forEach(m => {
      let p = byBn[m.bn];
      if (!p) {
        const c = (byName[norm(m.fullName)] || []).filter(x => !x.nbbId || String(x.nbbId) === m.bn);
        if (c.length > 1) { dubbel.push({ member: m, kandidaten: c.map(x => x.id) }); return; }
        if (c.length === 1) p = c[0];
      }
      if (!p) { nieuw.push(m); return; }
      if (assigned[p.id] && assigned[p.id].bn !== m.bn) { conflict.push({ member: m, speler: p.id, ander: assigned[p.id].bn }); return; }
      assigned[p.id] = m;
    });
    const sortU = a => [...new Set(a)].sort((x, y) => x.localeCompare(y));
    const patch = {}; const changes = [];
    spelers.forEach(p => {
      const m = assigned[p.id];
      const curTeams = sortU(p.nbbTeams || []);
      if (m) {
        const newTeams = sortU(m.teams);
        const idChanged = String(p.nbbId || '') !== m.bn;
        const teamsChanged = JSON.stringify(curTeams) !== JSON.stringify(newTeams);
        if (idChanged || teamsChanged) {
          patch[p.id] = { nbbId: m.bn, nbbTeams: newTeams };
          changes.push({ id: p.id, naam: fullName(p), bn: m.bn, nieuwBn: idChanged, van: curTeams, naar: newTeams });
        }
      } else if (curTeams.length) {
        patch[p.id] = { nbbTeams: [] };
        changes.push({ id: p.id, naam: fullName(p), bn: p.nbbId || '', nieuwBn: false, van: curTeams, naar: [] });
      }
    });
    return { patch, changes, nieuw, dubbel, conflict };
  }

  function newSpelerFromMember(m) {
    const sp = (m.firstName || m.lastName)
      ? { voornaam: m.firstName || '', tussenvoegsel: m.nameInfix || '', achternaam: m.lastName || '' }
      : splitName(m.fullName);
    const o = { id: uid(), voornaam: sp.voornaam, tussenvoegsel: sp.tussenvoegsel, achternaam: sp.achternaam,
      team: '', teams: [], role: '', license: '', status: 'available', reason: '', nbbId: m.bn, nbbTeams: [...new Set(m.teams)].sort() };
    o.name = fullName(o);
    return o;
  }

  const Core = { CFG, ROLE_OF_SLOT, ROLE_NAME, SLOT_LABEL, norm, fullName, nameMatches, splitName, mondayOf, isoLocal,
    selectMatches, desiredSlots, buildPeople, planMatch, putBody, planPlayerImport, newSpelerFromMember, rowCurrent, asItems };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

  /* ===================== Browser: API-lagen ===================== */
  function findToken() {
    const re = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
    const stores = [];
    try { stores.push(root.sessionStorage); } catch (e) { /* */ }
    try { stores.push(root.localStorage); } catch (e) { /* */ }
    const now = Date.now() / 1000;
    for (const st of stores) {
      if (!st) continue;
      for (let i = 0; i < st.length; i++) {
        const v = st.getItem(st.key(i)); const m = v && v.match(re);
        if (!m) continue;
        try {
          const payload = JSON.parse(atob(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.exp && payload.exp < now) continue;
        } catch (e) { continue; }
        return m[0];
      }
    }
    return null;
  }

  let TOKEN = null;
  async function foys(method, path, body) {
    if (!TOKEN) TOKEN = findToken();
    if (!TOKEN) throw new Error('Geen geldige clubbeheer-sessie gevonden. Log (opnieuw) in op club.basketball.nl en start de sync opnieuw.');
    const headers = { Accept: 'application/json', 'X-Cluster': 'cluster-default', Authorization: 'Bearer ' + TOKEN };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(CFG.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) { TOKEN = null; throw new Error('basketball.nl weigert de sessie (' + res.status + '). Log opnieuw in en probeer het nog eens.'); }
    if (!res.ok) { let t = ''; try { t = (await res.text()).slice(0, 300); } catch (e) { /* */ } const err = new Error('HTTP ' + res.status + (t ? ': ' + t : '')); err.status = res.status; throw err; }
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function sb(method, path, body, prefer) {
    const headers = { apikey: CFG.supabaseKey, Authorization: 'Bearer ' + CFG.supabaseKey, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(CFG.supabaseUrl + '/rest/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function loadState() {
    const rows = await sb('GET', 'app_state?select=key,data&key=in.(wedstrijden,indeling,spelers,instellingen,poule)');
    const d = {}; rows.forEach(r => { d[r.key] = r.data; });
    return { wedstrijden: d.wedstrijden || [], indeling: d.indeling || {}, spelers: d.spelers || [], poule: d.poule || [], instellingen: d.instellingen || {} };
  }
  async function loadSyncFilled(matchIds) {
    const set = new Set();
    if (!matchIds.length) return set;
    const ids = matchIds.map(x => '"' + String(x).replace(/"/g, '') + '"').join(',');
    const rows = await sb('GET', 'sync_log?select=row_id,bondsnummer&status=eq.ok&actie=in.(toegevoegd,vervangen)&match_id=in.(' + ids + ')');
    (rows || []).forEach(r => set.add(r.row_id + '|' + r.bondsnummer));
    return set;
  }
  const officialsPath = id => '/competition/management-api/v1/matches/' + encodeURIComponent(id) + '/match-officials/all?matchId=' + encodeURIComponent(id);

  /* Persoon -> bondsnummer: eerst nbbId uit de taakplanner, anders members/lookup op achternaam en exact op naam */
  const lookupCache = {};
  async function resolve(pid, people) {
    const p = people.byId[pid];
    if (!p) return { pid, name: '(onbekende speler ' + pid + ')', bn: null, unresolved: true, warn: 'speler bestaat niet meer in de taakplanner' };
    const name = fullName(p);
    if (p.nbbId) return { pid, name, bn: String(p.nbbId) };
    const ach = String(p.achternaam || splitName(name).achternaam || '').trim();
    if (!ach) return { pid, name, bn: null, unresolved: true, warn: 'geen achternaam om op te zoeken' };
    if (!lookupCache[ach]) {
      lookupCache[ach] = foys('GET', '/foys/api/v2/ops/organisations/' + CFG.org + '/members/lookup?organisationId=' + CFG.org + '&maxResultCount=50&skipCount=0&search=' + encodeURIComponent(ach))
        .then(r => asItems(r)).then(async r => { await sleep(CFG.pauseMs); return r; });
    }
    const items = await lookupCache[ach];
    const hits = items.filter(m => nameMatches(m, name));
    if (hits.length === 1) return { pid, name, bn: bnOf(hits[0]) || null, found: true, unresolved: !bnOf(hits[0]) };
    if (hits.length > 1) return { pid, name, bn: null, unresolved: true, warn: hits.length + ' leden met exact deze naam in basketball.nl \u2014 vul het bondsnummer in de taakplanner in' };
    return { pid, name, bn: null, unresolved: true, warn: 'niet gevonden in basketball.nl' };
  }

  /* ===================== Officials: droge run, doorvoeren, hercontrole ===================== */
  async function dryRun(opts, log) {
    const data = await loadState();
    const people = buildPeople(data);
    const matches = selectMatches(data, opts);
    log('Wedstrijden in selectie: ' + matches.length);
    const syncFilled = await loadSyncFilled(matches.map(m => m.nbbId).filter(Boolean));
    const resolved = {}; const learned = {};
    const results = [];
    for (const m of matches) {
      const res = { match: m, ops: [], error: null, rows: null };
      results.push(res);
      if (!m.nbbId) { res.error = 'geen NBB-wedstrijdnummer in de taakplanner'; continue; }
      try {
        res.rows = asItems(await foys('GET', officialsPath(m.nbbId)));
      } catch (e) {
        if (e.status === 404) { res.error = 'wedstrijd niet gevonden op basketball.nl'; continue; }
        throw e;
      }
      await sleep(CFG.pauseMs);
      const slots = [];
      for (const d of desiredSlots(m, data.indeling)) {
        if (!d.pid) { slots.push(Object.assign({}, d, { name: '', bn: null })); continue; }
        if (!resolved[d.pid]) {
          resolved[d.pid] = await resolve(d.pid, people);
          if (resolved[d.pid].found && resolved[d.pid].bn && data.spelers.some(s => s.id === d.pid)) learned[d.pid] = resolved[d.pid].bn;
        }
        slots.push(Object.assign({}, d, resolved[d.pid]));
      }
      res.slots = slots;
      res.ops = planMatch(slots, res.rows, { allowClear: opts.allowClear, syncFilled, people }).ops;
      log('Bekeken: ' + m.date + ' ' + (m.time || '') + ' ' + m.homeTeam);
    }
    return { data, people, results, learned, syncFilled, opts };
  }

  async function execute(run, log) {
    const runId = uuid();
    const logRows = [];
    const base = (m, op) => ({ run_id: runId, match_id: String(m.nbbId || ''), wedstrijd_id: m.id, row_id: op.row ? op.row.id : null,
      role_id: op.roleId || null, slot: op.slot, speler_id: op.want && op.want.pid || null });
    for (const res of run.results) {
      if (res.error) { logRows.push({ run_id: runId, match_id: String(res.match.nbbId || ''), wedstrijd_id: res.match.id, actie: 'fout', status: 'fout', melding: res.error }); continue; }
      let todo = res.ops.filter(o => ['toevoegen', 'vervangen', 'leegmaken'].includes(o.type));
      // Leegmaken eerst: dan zijn personen vrij voor een andere rol in dezelfde wedstrijd
      todo.sort((a, b) => (a.type === 'leegmaken' ? 0 : 1) - (b.type === 'leegmaken' ? 0 : 1));
      for (let pass = 0; pass < 2 && todo.length; pass++) {
        const failed = [];
        for (const op of todo) {
          const bn = op.type === 'leegmaken' ? null : op.want.bn;
          try {
            await foys('PUT', '/competition/management-api/v1/matches/' + encodeURIComponent(res.match.nbbId) + '/match-officials/' + op.row.id, putBody(op.row, res.match.nbbId, bn));
            op.done = true;
            log((op.type === 'leegmaken' ? 'Leeggemaakt: ' : 'Ingevoerd: ') + res.match.nbbId + ' ' + ROLE_NAME[op.roleId] + (bn ? ' \u2192 ' + op.want.name : ''));
            logRows.push(Object.assign(base(res.match, op), { bondsnummer: bn, persoon: bn ? op.want.name : null,
              vorige_bondsnummer: op.cur ? op.cur.bn : null, vorige_persoon: op.cur ? op.cur.name : null,
              actie: op.type === 'toevoegen' ? 'toegevoegd' : op.type === 'vervangen' ? 'vervangen' : 'leeggemaakt', status: 'ok' }));
          } catch (e) {
            if (e.status === 401 || e.status === 403) throw e;
            op.error = e.message; failed.push(op);
          }
          await sleep(CFG.pauseMs);
        }
        todo = failed;
      }
      todo.forEach(op => logRows.push(Object.assign(base(res.match, op), { bondsnummer: op.want && op.want.bn || null, persoon: op.want && op.want.name || null, actie: 'fout', status: 'fout', melding: op.error })));
    }
    // Geleerde bondsnummers terugschrijven naar de spelers
    if (Object.keys(run.learned).length) {
      const patch = {}; Object.entries(run.learned).forEach(([pid, bn]) => { patch[pid] = { nbbId: bn }; });
      try { await sb('POST', 'rpc/nbb_patch_spelers', { p_patch: patch, p_nieuw: [] }); log('Bondsnummers vastgelegd voor ' + Object.keys(patch).length + ' speler(s)'); }
      catch (e) { log('Let op: bondsnummers niet opgeslagen \u2014 ' + e.message); }
    }
    // Hercontrole
    log('Hercontrole\u2026');
    const people = buildPeople(run.data);
    Object.entries(run.learned).forEach(([pid, bn]) => { people.knownBns.add(bn); });
    const check = [];
    for (const res of run.results) {
      if (res.error || !res.slots) continue;
      let rows;
      try { rows = asItems(await foys('GET', officialsPath(res.match.nbbId))); }
      catch (e) { if (e.status === 401 || e.status === 403) throw e; check.push({ match: res.match, error: e.message }); continue; }
      await sleep(CFG.pauseMs);
      const ops = planMatch(res.slots, rows, { allowClear: true, syncFilled: new Set(), people: { knownBns: new Set(), knownNames: new Set(), byId: {} } }).ops;
      check.push({ match: res.match, ops });
      ops.forEach(op => {
        if (!op.slot) return; // extra rij zonder planner-slot: niet relevant voor de status
        const now = op.row ? rowCurrent(op.row) : null;
        const ok = op.type === 'gelijk';
        const skipped = op.want && op.want.pid && !op.want.bn && !ok;
        logRows.push(Object.assign(base(res.match, op), { bondsnummer: op.want && op.want.bn || null, persoon: op.want && op.want.name || null,
          vorige_bondsnummer: now ? now.bn : null, vorige_persoon: now ? now.name : null, actie: 'controle',
          status: ok ? 'ok' : skipped ? 'overgeslagen' : 'afwijking',
          melding: ok ? (op.warn || null) : (op.warn || ('op basketball.nl staat ' + (now ? now.name : 'niemand'))) }));
      });
    }
    // Logboek wegschrijven (in blokken)
    for (let i = 0; i < logRows.length; i += 200) {
      try { await sb('POST', 'sync_log', logRows.slice(i, i + 200), 'return=minimal'); }
      catch (e) { log('Let op: logboek niet volledig opgeslagen \u2014 ' + e.message); break; }
    }
    return { runId, check, logRows };
  }

  /* ===================== Spelersimport ===================== */
  async function readNbbMembers(log) {
    const seasons = asItems(await foys('GET', '/competition/management-api/v1/seasons/lookup?sorting=name'));
    const season = seasons.find(s => s.isActive) || null;
    if (!season) throw new Error('Geen actief seizoen gevonden op basketball.nl');
    log('Seizoen: ' + (season.name || season.displayName || season.id));
    const teams = asItems(await foys('GET', '/competition/management-api/v1/teams?skipCount=0&maxResultCount=200&seasonId=' + encodeURIComponent(season.id)));
    log('Teams: ' + teams.length);
    const today = isoLocal(new Date());
    const byBn = {};
    for (const t of teams) {
      await sleep(CFG.pauseMs);
      const r = await foys('GET', '/competition/management-api/v1/teams/' + encodeURIComponent(t.id) + '/team-members?skipCount=0&maxResultCount=100&teamId=' + encodeURIComponent(t.id));
      const items = asItems(r);
      if (r && r.totalCount > items.length) log('Let op: ' + t.name + ' heeft meer dan ' + items.length + ' leden; alleen de eerste ' + items.length + ' gelezen');
      items.forEach(it => {
        if (it.endDate && String(it.endDate).slice(0, 10) < today) return;
        const p = it.person || {}; const bn = bnOf(p);
        if (!bn) return;
        const m = byBn[bn] || (byBn[bn] = { bn, fullName: p.fullName || memberName(p), firstName: p.firstName, nameInfix: p.nameInfix, lastName: p.lastName, teams: [], rollen: [] });
        if (!m.teams.includes(t.name)) m.teams.push(t.name);
        if (it.matchRole && it.matchRole.name) m.rollen.push(t.name + ': ' + it.matchRole.name);
      });
      log('Gelezen: ' + t.name + ' (' + items.length + ')');
    }
    return { season, teams, members: Object.values(byBn) };
  }

  /* ===================== UI ===================== */
  if (root.__zoebasSync && root.__zoebasSync.show) { root.__zoebasSync.show(); return; }
  if (!/(^|\.)basketball\.nl$/.test(root.location.hostname)) {
    alert('Start deze bookmarklet op club.basketball.nl (ingelogd in clubbeheer).');
    return;
  }

  const host = document.createElement('div');
  host.id = 'zoebas-sync-host';
  document.body.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>
    :host{all:initial}
    .p{position:fixed;top:12px;right:12px;bottom:12px;width:min(760px,calc(100vw - 24px));z-index:2147483646;background:#fff;color:#121722;
      font:13px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
    .h{background:#13110a;color:#fff;border-bottom:3px solid #e0b000;padding:10px 14px;display:flex;align-items:center;gap:10px}
    .h b{font-size:15px}.h .sp{flex:1}
    .tabs{display:flex;gap:4px}
    button{font:inherit;border:1px solid #dfe4ec;background:#fff;color:#121722;border-radius:8px;padding:6px 12px;cursor:pointer}
    button:hover{border-color:#6a7585}
    button.pri{background:#e0b000;border-color:#e0b000;color:#13110a;font-weight:600}
    button.dng{background:#b91c1c;border-color:#b91c1c;color:#fff;font-weight:600}
    button:disabled{opacity:.5;cursor:default}
    .h button{background:transparent;color:#fff;border-color:#555}.h button.on{background:#e0b000;color:#13110a;border-color:#e0b000}
    .b{flex:1;overflow:auto;padding:12px 14px}
    .f{border-top:1px solid #dfe4ec;padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .muted{color:#6a7585}.small{font-size:12px}
    .weeks{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}
    .weeks label,.opt{display:inline-flex;gap:5px;align-items:center;border:1px solid #dfe4ec;border-radius:999px;padding:3px 10px;cursor:pointer}
    .opt{border:none;padding:2px 0;margin-right:14px}
    table{width:100%;border-collapse:collapse;margin:4px 0 14px}
    th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eef1f5;vertical-align:top}
    table.ops{table-layout:fixed}table.ops th:nth-child(1){width:20%}table.ops th:nth-child(4){width:26%}
    th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#6a7585}
    .mh{font-weight:600;margin-top:8px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
    .mh a{color:#2563eb;font-weight:400;font-size:12px}
    .tag{display:inline-block;border-radius:999px;padding:0 8px;font-size:11px;font-weight:600}
    .t-gelijk{background:#e7f6ec;color:#166534}.t-toevoegen{background:#dbeafe;color:#1e40af}.t-vervangen{background:#fef3c7;color:#92400e}
    .t-leegmaken{background:#fee2e2;color:#991b1b}.t-overslaan{background:#eef1f5;color:#475569}.t-fout,.t-afwijking{background:#fee2e2;color:#991b1b}
    .warn{color:#b45309;font-size:12px}.err{color:#b91c1c}
    .log{font:11px/1.4 ui-monospace,Menlo,monospace;color:#6a7585;white-space:pre-wrap;max-height:110px;overflow:auto;background:#f6f7f9;border-radius:6px;padding:6px 8px;margin-top:8px}
    .sum{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 10px}
    .sum span{background:#eef1f5;border-radius:6px;padding:3px 8px}
    .hide{display:none}
  </style>
  <div class="p">
    <div class="h"><b>Taakplanner \u2192 basketball.nl</b><span class="sp"></span>
      <div class="tabs"><button data-tab="off" class="on">Officials</button><button data-tab="spl">Spelers</button></div>
      <button id="x" title="Sluiten">\u2715</button></div>
    <div class="b" id="body"></div>
    <div class="f" id="foot"></div>
  </div>`;
  const $ = s => sh.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtD = d => { const x = new Date(d + 'T00:00:00'); return x.toLocaleDateString('nl-NL', { weekday: 'short', day: '2-digit', month: '2-digit' }); };
  const matchUrl = id => 'https://club.basketball.nl/management/' + CFG.org + '/spas/competition/matches/' + encodeURIComponent(id);
  const state = { tab: 'off', busy: false, run: null, done: null, imp: null, logLines: [] };
  function log(s) { state.logLines.push(s); const el = $('#log'); if (el) { el.textContent = state.logLines.slice(-200).join('\n'); el.scrollTop = el.scrollHeight; } }
  function setBusy(b) { state.busy = b; sh.querySelectorAll('.f button').forEach(x => { x.disabled = b; }); }
  function fail(e) { setBusy(false); log('FOUT: ' + e.message); const el = $('#msg'); if (el) el.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }

  $('#x').onclick = () => { host.style.display = 'none'; };
  sh.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    if (state.busy) return;
    state.tab = b.dataset.tab; sh.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); render();
  });

  let cached = null;
  async function ensureState() { if (!cached) cached = await loadState(); return cached; }

  function render() { state.tab === 'off' ? renderOfficials() : renderSpelers(); }

  /* ---------- Officials ---------- */
  async function renderOfficials() {
    const body = $('#body'), foot = $('#foot');
    if (state.done) return renderDone();
    if (state.run) return renderPlan();
    body.innerHTML = '<p class="muted">Gegevens laden\u2026</p>'; foot.innerHTML = '';
    let data; try { data = await ensureState(); } catch (e) { body.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
    const today = isoLocal(new Date()); const curMonday = mondayOf(today);
    const pub = [...(data.instellingen.gepubliceerd || [])].sort();
    const weekCount = w => (data.wedstrijden || []).filter(m => !m.away && m.date && mondayOf(m.date) === w).length;
    body.innerHTML = `<p>Kies de gepubliceerde weken die je wilt doorvoeren. De taakplanner is leidend: nieuwe namen worden toegevoegd, gewijzigde vervangen.
      Er wordt pas iets geschreven als je na de droge run op <b>Doorvoeren</b> klikt.</p>
      <div class="weeks">${pub.map(w => `<label><input type="checkbox" value="${w}" ${w >= curMonday ? 'checked' : ''}> week ${fmtD(w)} <span class="muted">(${weekCount(w)})</span></label>`).join('') || '<span class="muted">Er zijn nog geen weken gepubliceerd in de taakplanner.</span>'}</div>
      <label class="opt"><input type="checkbox" id="past"> ook wedstrijden in het verleden</label>
      <label class="opt"><input type="checkbox" id="clr"> rijen leegmaken als de plek in de planner leeg is</label>
      <p class="small muted">Leegmaken gebeurt alleen bij rijen die door de sync zijn gevuld of waarvan de persoon in de taakplanner staat.</p>
      <div id="msg"></div><div class="log" id="log"></div>`;
    foot.innerHTML = '<button class="pri" id="dry">Droge run</button>';
    $('#dry').onclick = async () => {
      const weeks = [...sh.querySelectorAll('.weeks input:checked')].map(i => i.value);
      if (!weeks.length) { $('#msg').innerHTML = '<p class="err">Kies minstens \u00e9\u00e9n week.</p>'; return; }
      setBusy(true); state.logLines = []; log('Droge run gestart');
      try {
        cached = null;
        state.run = await dryRun({ weeks, includePast: $('#past').checked, allowClear: $('#clr').checked, today }, log);
        setBusy(false); renderPlan();
      } catch (e) { fail(e); }
    };
  }

  function opsTable(ops) {
    return `<table class="ops"><thead><tr><th>Rol</th><th>Nu op basketball.nl</th><th>Taakplanner</th><th>Actie</th></tr></thead><tbody>${ops.map(op => `<tr>
      <td>${esc(SLOT_LABEL[op.slot] || ROLE_NAME[op.roleId] || '')}</td>
      <td>${op.cur ? esc(op.cur.name) : '<span class="muted">leeg</span>'}</td>
      <td>${op.want && op.want.pid ? esc(op.want.name) + (op.want.bn ? ' <span class="muted small">' + esc(op.want.bn) + '</span>' : '') : '<span class="muted">leeg</span>'}</td>
      <td><span class="tag t-${op.type}">${op.type}</span>${op.warn ? '<div class="warn">' + esc(op.warn) + '</div>' : ''}${op.error ? '<div class="err small">' + esc(op.error) + '</div>' : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderPlan() {
    const run = state.run, body = $('#body'), foot = $('#foot');
    const all = run.results.flatMap(r => r.ops);
    const cnt = t => all.filter(o => o.type === t).length;
    const errs = run.results.filter(r => r.error).length;
    const changes = cnt('toevoegen') + cnt('vervangen') + cnt('leegmaken');
    const showAll = state.showAll;
    const visible = run.results.filter(r => showAll || r.error || r.ops.some(o => o.type !== 'gelijk' || o.warn));
    body.innerHTML = `<div class="sum"><span>${run.results.length} wedstrijden</span><span>${cnt('gelijk')} gelijk</span><span>${cnt('toevoegen')} toevoegen</span>
      <span>${cnt('vervangen')} vervangen</span><span>${cnt('leegmaken')} leegmaken</span><span>${cnt('overslaan')} overslaan</span>${errs ? `<span class="err">${errs} niet gevonden</span>` : ''}</div>
      <label class="opt"><input type="checkbox" id="sa" ${showAll ? 'checked' : ''}> ook wedstrijden zonder wijzigingen tonen</label>
      ${Object.keys(run.learned).length ? `<p class="small muted">${Object.keys(run.learned).length} bondsnummer(s) gevonden via de ledenlijst; die worden bij doorvoeren in de taakplanner opgeslagen.</p>` : ''}
      ${visible.map(r => `<div class="mh">${fmtD(r.match.date)} ${esc(r.match.time || '')} \u00b7 ${esc(r.match.homeTeam)} \u2013 ${esc(r.match.awayTeam)}
        <a href="${matchUrl(r.match.nbbId)}" target="_blank" rel="noopener">${esc(r.match.nbbId || '\u2014')}</a></div>
        ${r.error ? `<p class="err small">${esc(r.error)}</p>` : opsTable(r.ops)}`).join('') || '<p class="muted">Alles staat al goed.</p>'}
      <div id="msg"></div><div class="log" id="log"></div>`;
    log('Droge run klaar: ' + changes + ' wijziging(en)');
    $('#sa').onchange = e => { state.showAll = e.target.checked; renderPlan(); };
    foot.innerHTML = `<button id="back">Terug</button><span style="flex:1"></span>
      <button class="${changes ? 'dng' : 'pri'}" id="go">${changes ? 'Doorvoeren (' + changes + ' wijziging' + (changes === 1 ? '' : 'en') + ')' : 'Status vastleggen in taakplanner'}</button>`;
    $('#back').onclick = () => { state.run = null; renderOfficials(); };
    $('#go').onclick = async () => {
      if (changes && !confirm(changes + ' wijziging(en) doorvoeren op basketball.nl?')) return;
      setBusy(true);
      try { state.done = await execute(run, log); setBusy(false); renderDone(); } catch (e) { fail(e); }
    };
  }

  function renderDone() {
    const d = state.done, body = $('#body'), foot = $('#foot');
    const dev = d.logRows.filter(r => r.actie === 'controle' && r.status === 'afwijking');
    const fouten = d.logRows.filter(r => r.status === 'fout');
    const done = d.logRows.filter(r => ['toegevoegd', 'vervangen', 'leeggemaakt'].includes(r.actie));
    body.innerHTML = `<div class="sum"><span>${done.length} doorgevoerd</span><span>${dev.length ? '<b class="err">' + dev.length + ' afwijking(en)</b>' : '0 afwijkingen'}</span>${fouten.length ? `<span class="err">${fouten.length} fout(en)</span>` : ''}</div>
      <p>Hercontrole na het doorvoeren:</p>
      ${d.check.filter(c => c.error || c.ops.some(o => o.type !== 'gelijk')).map(c => `<div class="mh">${fmtD(c.match.date)} ${esc(c.match.time || '')} \u00b7 ${esc(c.match.homeTeam)}
        <a href="${matchUrl(c.match.nbbId)}" target="_blank" rel="noopener">${esc(c.match.nbbId)}</a></div>${c.error ? `<p class="err small">${esc(c.error)}</p>` : opsTable(c.ops)}`).join('') || '<p>Alles klopt: basketball.nl komt overeen met de taakplanner.</p>'}
      ${fouten.length ? '<p class="err">Fouten:</p><ul>' + fouten.map(f => '<li>' + esc(f.match_id + ' ' + (f.slot || '') + ': ' + f.melding) + '</li>').join('') + '</ul>' : ''}
      <p class="small muted">Resultaat vastgelegd in de taakplanner (sync_log, run ${esc(d.runId.slice(0, 8))}).</p>
      <div class="log" id="log"></div>`;
    log('Klaar');
    foot.innerHTML = '<button class="pri" id="again">Nieuwe droge run</button>';
    $('#again').onclick = () => { state.done = null; state.run = null; cached = null; renderOfficials(); };
  }

  /* ---------- Spelers ---------- */
  async function renderSpelers() {
    const body = $('#body'), foot = $('#foot');
    if (state.imp) return renderImport();
    body.innerHTML = `<p>Leest alle teams van het actieve seizoen en hun leden uit basketball.nl (alleen lezen) en vult in de taakplanner het
      <b>bondsnummer</b> en de <b>NBB-teams</b> aan. Teams, rol, niveau en status in de taakplanner blijven ongemoeid.</p>
      <div id="msg"></div><div class="log" id="log"></div>`;
    foot.innerHTML = '<button class="pri" id="read">Teams en leden lezen</button>';
    $('#read').onclick = async () => {
      setBusy(true); state.logLines = []; log('Lezen gestart');
      try {
        cached = null;
        const data = await ensureState();
        const nbb = await readNbbMembers(log);
        state.imp = Object.assign(planPlayerImport(data.spelers, nbb.members), { nbb });
        setBusy(false); renderImport();
      } catch (e) { fail(e); }
    };
  }

  function renderImport() {
    const imp = state.imp, body = $('#body'), foot = $('#foot');
    const nieuwBn = imp.changes.filter(c => c.nieuwBn).length;
    body.innerHTML = `<div class="sum"><span>${imp.nbb.members.length} NBB-leden in ${imp.nbb.teams.length} teams</span><span>${nieuwBn} nieuw bondsnummer</span>
      <span>${imp.changes.length} speler(s) bijgewerkt</span><span>${imp.nieuw.length} nieuw in basketball.nl</span>${imp.dubbel.length + imp.conflict.length ? `<span class="err">${imp.dubbel.length + imp.conflict.length} twijfelgeval(len)</span>` : ''}</div>
      ${imp.changes.length ? `<p><b>Wijzigingen</b></p><table><thead><tr><th>Speler</th><th>Bondsnr.</th><th>NBB-teams nu</th><th>Wordt</th></tr></thead><tbody>${imp.changes.map(c => `<tr><td>${esc(c.naam)}</td><td>${esc(c.bn)}${c.nieuwBn ? ' <span class="tag t-toevoegen">nieuw</span>' : ''}</td><td>${esc(c.van.join(', ') || '\u2014')}</td><td>${esc(c.naar.join(', ') || '\u2014')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Bondsnummers en NBB-teams zijn al bijgewerkt.</p>'}
      ${imp.dubbel.length || imp.conflict.length ? `<p><b>Twijfelgevallen</b> \u2014 niet gekoppeld; vul het bondsnummer in de taakplanner in:</p><ul>${imp.dubbel.map(x => `<li>${esc(x.member.fullName)} (${esc(x.member.bn)}): ${x.kandidaten.length} spelers met deze naam</li>`).join('')}${imp.conflict.map(x => `<li>${esc(x.member.fullName)} (${esc(x.member.bn)}): speler is al gekoppeld aan ${esc(x.ander)}</li>`).join('')}</ul>` : ''}
      ${imp.nieuw.length ? `<p><b>Nieuw in basketball.nl</b> \u2014 niet in de taakplanner. Vink aan wie je als speler wilt toevoegen (zonder rol):</p>
        <table><thead><tr><th></th><th>Naam</th><th>Bondsnr.</th><th>Team(s)</th></tr></thead><tbody>${imp.nieuw.map((m, i) => `<tr><td><input type="checkbox" data-new="${i}"></td><td>${esc(m.fullName)}</td><td>${esc(m.bn)}</td><td>${esc(m.rollen.join(', ') || m.teams.join(', '))}</td></tr>`).join('')}</tbody></table>` : ''}
      <div id="msg"></div><div class="log" id="log"></div>`;
    foot.innerHTML = `<button id="back">Terug</button><span style="flex:1"></span><button class="pri" id="save">Opslaan in taakplanner</button>`;
    $('#back').onclick = () => { state.imp = null; renderSpelers(); };
    $('#save').onclick = async () => {
      const nieuw = [...sh.querySelectorAll('[data-new]:checked')].map(i => newSpelerFromMember(imp.nieuw[Number(i.dataset.new)]));
      if (!Object.keys(imp.patch).length && !nieuw.length) { $('#msg').innerHTML = '<p class="muted">Niets op te slaan.</p>'; return; }
      setBusy(true);
      try {
        const n = await sb('POST', 'rpc/nbb_patch_spelers', { p_patch: imp.patch, p_nieuw: nieuw });
        log('Opgeslagen: ' + Object.keys(imp.patch).length + ' bijgewerkt, ' + nieuw.length + ' toegevoegd (' + n + ' spelers totaal)');
        state.imp = null; cached = null; setBusy(false);
        $('#body').innerHTML = `<p>Opgeslagen in de taakplanner: ${Object.keys(imp.patch).length} speler(s) bijgewerkt, ${nieuw.length} toegevoegd.</p><div class="log" id="log"></div>`;
        log('Klaar');
        $('#foot').innerHTML = '<button id="back2">Opnieuw lezen</button>';
        $('#back2').onclick = () => renderSpelers();
      } catch (e) { fail(e); }
    };
  }

  root.__zoebasSync = { show() { host.style.display = ''; } };
  render();
})(typeof window !== 'undefined' ? window : globalThis);
