'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { csrf: '', user: null, classes: [], users: [], register: null, dirty: false, reportQuery: null };
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
$$('input[type=date]').forEach(input => { if (input.name === 'date' || input.name === 'startDate') input.value = localDate; });
$('input[type=month]').value = localDate.slice(0, 7);

function notice(message, error = false) {
  const box = $('#notice'); box.hidden = !message; box.textContent = message; box.classList.toggle('error', error);
}
async function request(url, options = {}) {
  const init = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (init.method && init.method !== 'GET') {
    init.headers['X-CSRF-Token'] = state.csrf;
    if (init.body && !(init.body instanceof FormData)) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(init.body); }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let body = {}; try { body = await response.json(); } catch (_) { /* use HTTP status */ }
    const err = new Error(body.error || `Request failed (${response.status}).`); err.status = response.status; throw err;
  }
  if (response.status === 204) return null;
  return response.json();
}
function run(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button[type=submit], button:not([type])', form); const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Loading…'; }
    notice('');
    try { await action(new FormData(form)); } catch (error) { notice(error.message, true); }
    finally { if (button) { button.disabled = false; button.textContent = original; } }
  });
}
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function cell(row, value, css) { const node = document.createElement('td'); node.textContent = value ?? ''; if (css) node.className = css; row.append(node); return node; }
function listItem(parent, text) { const li = document.createElement('li'); li.textContent = text; parent.append(li); }
function className(id) { return state.classes.find(item => String(item.id) === String(id))?.name || `Class ${id}`; }
function query(data) { return new URLSearchParams(data).toString(); }
async function refreshClasses() {
  const data = await request('/api/classes'); state.classes = data.classes;
  $$('.class-select').forEach(select => {
    const old = select.value; select.replaceChildren(option('', 'Select a class'));
    state.classes.forEach(item => select.append(option(item.id, item.name)));
    if (state.classes.some(item => String(item.id) === old)) select.value = old;
  });
  const list = $('#class-list'); list.replaceChildren(); state.classes.forEach(item => {
    const li = document.createElement('li'); const label = document.createElement('span'); label.textContent = item.name;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Edit'; button.setAttribute('aria-label', `Edit class ${item.name}`);
    button.addEventListener('click', () => { const form = $('#class-form'); form.elements.id.value = item.id; form.elements.name.value = item.name; $('#class-form-title').textContent = 'Edit class'; form.elements.name.focus(); });
    li.append(label, button); list.append(li);
  });
}
async function refreshUsers() {
  const data = await request('/api/users'); state.users = data.users; const list = $('#user-list'); list.replaceChildren();
  const select = $('#faculty-select'); const old = select.value; select.replaceChildren(option('', 'Select faculty'));
  state.users.forEach(item => {
    const li = document.createElement('li'); const label = document.createElement('span'); label.textContent = `${item.username} · ${item.role}${item.active ? '' : ' · inactive'}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Edit'; button.setAttribute('aria-label', `Edit account ${item.username}`);
    button.addEventListener('click', () => { const form = $('#user-form'); form.elements.id.value = item.id; form.elements.username.value = item.username; form.elements.role.value = item.role; form.elements.active.disabled = false; form.elements.active.checked = item.active; form.elements.password.value = ''; form.elements.password.required = false; $('#user-form-title').textContent = 'Edit account'; form.elements.username.focus(); });
    li.append(label, button); list.append(li); if (item.role === 'faculty' && item.active) select.append(option(item.id, item.username));
  });
  select.value = old;
}
async function refreshAssignments() {
  const data = await request('/api/assignments'); const list = $('#assignment-list'); list.replaceChildren();
  if (!data.assignments.length) listItem(list, 'No assignments yet.');
  data.assignments.forEach(item => {
    const li = document.createElement('li'); const label = document.createElement('span'); label.textContent = `${item.username} · ${item.className}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Revoke'; button.setAttribute('aria-label', `Revoke ${item.username} from ${item.className}`);
    button.addEventListener('click', async () => { button.disabled = true; try { await request('/api/assignments', { method: 'DELETE', body: { userId: item.userId, classId: item.classId } }); await refreshAssignments(); notice('Assignment revoked.'); } catch (error) { notice(error.message, true); button.disabled = false; } });
    li.append(label, button); list.append(li);
  });
}
async function refreshSettings() {
  const data = await request('/api/settings'); $('#threshold-form').elements.threshold.value = data.threshold;
  const list = $('#calendar-list'); list.replaceChildren();
  if (!data.calendar.length) listItem(list, 'No exceptions configured.');
  data.calendar.forEach(item => listItem(list, `${item.date}: ${item.periods.length ? item.periods.map(p => `P${p}`).join(', ') : 'No eligible periods'}`));
}
async function session() {
  const data = await request('/api/session'); state.csrf = data.csrfToken; state.user = data.user;
  $('#login-view').hidden = !!state.user; $('#app').hidden = !state.user; $('#identity').hidden = !state.user;
  if (!state.user) return;
  $('#user-label').textContent = `${state.user.username} · ${state.user.role}`;
  $$('[data-admin]').forEach(node => { node.hidden = state.user.role !== 'admin'; });
  await refreshClasses();
  if (state.user.role === 'admin') { await Promise.all([refreshUsers(), refreshAssignments(), refreshSettings()]); }
}
run($('#login-form'), async data => {
  await request('/api/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
  $('#login-form').reset(); await session(); notice('Signed in successfully.');
});
$('#logout').addEventListener('click', async () => {
  if (state.dirty && !window.confirm('You have unsaved attendance changes. Sign out and discard them?')) return;
  try { await request('/api/logout', { method: 'POST' }); state.register = null; state.dirty = false; $('#attendance-content').hidden = true; await session(); notice('Signed out.'); }
  catch (error) { notice(error.message, true); }
});
$('#navigation').addEventListener('click', event => {
  const button = event.target.closest('button[data-view]'); if (!button) return;
  $$('.view').forEach(section => { section.hidden = section.id !== button.dataset.view; });
  $$('#navigation button').forEach(item => { if (item === button) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
  notice(''); const heading = $(`#${button.dataset.view} h2`); heading.tabIndex = -1; heading.focus({ preventScroll: true });
});
function dirtyMessage(message) { $('#attendance-state').textContent = message; }
function renderRegister(data) {
  state.register = data; state.dirty = false; $('#attendance-content').hidden = false;
  $('#register-title').textContent = `${className(data.classId)} · ${data.date}`;
  $('#register-detail').textContent = `Version ${data.version} · ${data.students.length} student(s) · Eligible periods: ${data.periods.length ? data.periods.map(p => `P${p}`).join(', ') : 'none'}`;
  const rows = $('#attendance-rows'); rows.replaceChildren();
  if (!data.students.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No students are enrolled for this date.'); td.colSpan = 9; rows.append(tr); }
  for (const student of data.students) {
    const tr = document.createElement('tr'); cell(tr, student.roll); cell(tr, student.name);
    for (let period = 1; period <= 7; period++) {
      const td = document.createElement('td'); tr.append(td);
      if (!data.periods.includes(period)) { td.textContent = '—'; continue; }
      const select = document.createElement('select'); select.dataset.studentId = student.id; select.dataset.period = period;
      select.setAttribute('aria-label', `${student.name}, period ${period}`);
      select.append(option('U', 'U'), option('P', 'P'), option('A', 'A')); select.value = student.statuses[String(period)] || 'U';
      select.addEventListener('change', () => { state.dirty = true; dirtyMessage('Unsaved changes.'); }); td.append(select);
    }
    rows.append(tr);
  }
  $('#attendance-save').elements.reason.value = ''; dirtyMessage('Register loaded.');
}
async function loadRegister(data, force = false) {
  if (!force && state.dirty && !window.confirm('You have unsaved attendance changes. Discard them and load another register?')) return;
  const result = await request(`/api/attendance?${query({ classId: data.get('classId'), date: data.get('date') })}`); renderRegister(result);
}
run($('#attendance-filter'), async data => { await loadRegister(data); });
$('#attendance-reload').addEventListener('click', async () => {
  try { await loadRegister(new FormData($('#attendance-filter'))); } catch (error) { notice(error.message, true); }
});
$$('[data-bulk]').forEach(button => button.addEventListener('click', () => {
  $$('#attendance-rows select').forEach(select => { select.value = button.dataset.bulk; }); state.dirty = true; dirtyMessage('Unsaved changes.');
}));
run($('#attendance-save'), async data => {
  if (!state.register) return;
  const entries = $$('#attendance-rows select').map(select => ({ studentId: Number(select.dataset.studentId), period: Number(select.dataset.period), status: select.value }));
  try {
    await request('/api/attendance', { method: 'PUT', body: { classId: Number(state.register.classId), date: state.register.date, version: state.register.version, entries, reason: data.get('reason').trim() } });
    state.dirty = false;
    // Reload the exact saved date and class even if filter controls were changed.
    const saved = await request(`/api/attendance?${query({ classId: state.register.classId, date: state.register.date })}`); renderRegister(saved); dirtyMessage('Attendance saved and reloaded.');
  } catch (error) {
    if (error.status === 409) { state.dirty = true; dirtyMessage('This register changed elsewhere. Your selections are preserved; review them before choosing Reload saved register.'); }
    throw error;
  }
});
run($('#history-filter'), async data => {
  const params = query({ classId: data.get('classId'), date: data.get('date') });
  const [result, corrections] = await Promise.all([request(`/api/history?${params}`), request(`/api/audit?${params}`)]); $('#history-content').hidden = false; $('#history-heading').textContent = `${className(result.classId)} · ${result.date}`;
  const rows = $('#history-rows'); rows.replaceChildren();
  result.students.forEach(student => { const tr = document.createElement('tr'); cell(tr, student.roll); cell(tr, student.name); for (let p = 1; p <= 7; p++) cell(tr, result.periods.includes(p) ? student.statuses[String(p)] || 'U' : '—'); rows.append(tr); });
  if (!result.students.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No students are enrolled for this date.'); td.colSpan = 9; rows.append(tr); }
  const auditRows = $('#audit-rows'); auditRows.replaceChildren();
  corrections.audit.forEach(change => { const tr = document.createElement('tr'); const student = result.students.find(item => String(item.id) === String(change.studentId)); [student ? `${student.roll} · ${student.name}` : `Student ${change.studentId}`, `P${change.period}`, change.previous, change.value, change.reason, change.actor, change.timestamp].forEach(value => cell(tr, value)); auditRows.append(tr); });
  if (!corrections.audit.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No corrections for this date.'); td.colSpan = 7; auditRows.append(tr); }
});
let reportStudentLoad = 0;
$('#reports-filter').elements.classId.addEventListener('change', async event => {
  const load = ++reportStudentLoad;
  const classId = event.target.value; const form = $('#reports-filter'); const select = form.elements.studentId; const submit = $('button', form);
  select.replaceChildren(option('', 'All students')); if (!classId) { select.disabled = false; submit.disabled = false; return; }
  select.disabled = true; submit.disabled = true;
  try {
    const result = await request(`/api/students?${query({ classId })}`);
    if (load !== reportStudentLoad) return;
    result.students.forEach(student => select.append(option(student.id, `${student.roll} · ${student.name}`)));
  } catch (error) { if (load === reportStudentLoad) notice(error.message, true); }
  finally { if (load === reportStudentLoad) { select.disabled = false; submit.disabled = false; } }
});
run($('#reports-filter'), async data => {
  const params = { classId: data.get('classId'), month: data.get('month') }; if (data.get('studentId')) params.studentId = data.get('studentId');
  const result = await request(`/api/reports?${query(params)}`); state.reportQuery = params; $('#reports-content').hidden = false;
  const studentName = params.studentId ? result.students[0]?.name : null;
  $('#reports-heading').textContent = `${className(params.classId)} · ${result.month}${studentName ? ` · ${studentName}` : ''}`; $('#reports-detail').textContent = `Threshold: ${result.threshold}% · Working = present + absent + unmarked`;
  const rows = $('#reports-rows'); rows.replaceChildren();
  result.students.forEach(student => { const tr = document.createElement('tr'); [student.roll, student.name, student.working, student.present, student.absent, student.unmarked, student.percentage === null ? 'N/A' : `${Number(student.percentage).toFixed(2)}%`].forEach(value => cell(tr, value)); cell(tr, student.working === 0 ? 'No eligible periods' : !student.complete ? 'Preliminary · incomplete' : student.low ? 'Low attendance' : 'Complete', !student.complete ? 'status-preliminary' : student.low ? 'status-low' : ''); rows.append(tr); });
  if (!result.students.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No students found for this month.'); td.colSpan = 8; rows.append(tr); }
});
$('#csv').addEventListener('click', async () => {
  if (!state.reportQuery) return; const button = $('#csv'); button.disabled = true;
  try { const response = await fetch(`/api/reports.csv?${query(state.reportQuery)}`, { credentials: 'same-origin' }); if (!response.ok) { let body = {}; try { body = await response.json(); } catch (_) {} throw new Error(body.error || `Export failed (${response.status}).`); } const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `attendance-${state.reportQuery.month}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); notice('CSV exported.'); }
  catch (error) { notice(error.message, true); } finally { button.disabled = false; }
});
let students = [];
run($('#students-filter'), async data => { await loadStudents(data.get('classId')); });
async function loadStudents(classId) {
  const result = await request(`/api/students?${query({ classId })}`); students = result.students; const rows = $('#students-rows'); rows.replaceChildren();
  students.forEach(student => { const tr = document.createElement('tr'); cell(tr, student.roll); cell(tr, student.name); cell(tr, student.department); cell(tr, `${student.startDate} – ${student.endDate || 'ongoing'}${student.active ? '' : ' · inactive'}`); const td = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Edit'; button.setAttribute('aria-label', `Edit ${student.name}`); button.addEventListener('click', () => editStudent(student, classId)); td.append(button); tr.append(td); rows.append(tr); });
  if (!students.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No students found.'); td.colSpan = 5; rows.append(tr); }
}
function editStudent(student, classId) {
  const form = $('#student-form'); for (const name of ['id', 'roll', 'name', 'department', 'startDate', 'endDate']) form.elements[name].value = student[name] ?? ''; form.elements.classId.value = classId; form.elements.active.checked = !!student.active; $('#student-form-title').textContent = 'Edit student'; form.elements.roll.focus();
}
function resetStudent() { const form = $('#student-form'); form.reset(); form.elements.id.value = ''; form.elements.startDate.value = localDate; form.elements.classId.value = $('#students-filter').elements.classId.value; $('#student-form-title').textContent = 'Add student'; }
$('#student-reset').addEventListener('click', resetStudent);
run($('#student-form'), async data => {
  const id = data.get('id'); const body = { classId: Number(data.get('classId')), roll: data.get('roll').trim(), name: data.get('name').trim(), department: data.get('department').trim(), startDate: data.get('startDate'), endDate: data.get('endDate') || null };
  body.active = $('#student-form').elements.active.checked;
  await request(id ? `/api/students/${encodeURIComponent(id)}` : '/api/students', { method: id ? 'PUT' : 'POST', body });
  $('#students-filter').elements.classId.value = String(body.classId); await loadStudents(body.classId); resetStudent(); notice('Student saved.');
});
function resetClass() { $('#class-form').reset(); $('#class-form').elements.id.value = ''; $('#class-form-title').textContent = 'Create class'; }
function resetUser() { const form = $('#user-form'); form.reset(); form.elements.id.value = ''; form.elements.active.disabled = true; form.elements.password.required = true; $('#user-form-title').textContent = 'Create account'; }
$('#class-reset').addEventListener('click', resetClass); $('#user-reset').addEventListener('click', resetUser);
run($('#class-form'), async data => { const id = data.get('id'); await request(id ? `/api/classes/${encodeURIComponent(id)}` : '/api/classes', { method: id ? 'PUT' : 'POST', body: { name: data.get('name').trim() } }); resetClass(); await Promise.all([refreshClasses(), refreshAssignments()]); notice('Class saved.'); });
run($('#user-form'), async data => {
  const id = data.get('id'); const body = { username: data.get('username').trim(), role: data.get('role') };
  if (id) body.active = $('#user-form').elements.active.checked;
  if (data.get('password')) body.password = data.get('password');
  await request(id ? `/api/users/${encodeURIComponent(id)}` : '/api/users', { method: id ? 'PUT' : 'POST', body }); resetUser();
  const current = await request('/api/session');
  if (!current.user) { await session(); notice('Account saved. Please sign in again.'); return; }
  await Promise.all([refreshUsers(), refreshAssignments()]); notice('Account saved.');
});
run($('#assignment-form'), async data => { await request('/api/assignments', { method: 'POST', body: { userId: Number(data.get('userId')), classId: Number(data.get('classId')) } }); await refreshAssignments(); notice('Faculty assignment saved.'); });
run($('#threshold-form'), async data => { await request('/api/settings', { method: 'PUT', body: { threshold: Number(data.get('threshold')) } }); await refreshSettings(); notice('Threshold saved.'); });
run($('#calendar-form'), async data => { await request('/api/calendar', { method: 'PUT', body: { date: data.get('date'), periods: data.getAll('period').map(Number) } }); await refreshSettings(); notice('Calendar exception saved.'); });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
session().catch(error => notice(error.message, true));
