const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { transaction } = require('./db');
const { hashPassword, verifyPassword } = require('./security');

const allPeriods = [1,2,3,4,5,6,7];
const today = (instant = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
function fail(message, status = 400, code) { const e = new Error(message); e.status = status; e.code = code; throw e; }
function id(value, label = 'ID') { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) fail(`${label} must be a positive integer`); return n; }
function text(value, label, max = 100) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required and must be at most ${max} characters`); return value.trim(); }
function date(value, label = 'Date') { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0,4)) < 1900 || Number(value.slice(0,4)) > 9999 || Number.isNaN(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) fail(`${label} must be a valid YYYY-MM-DD date`); return value; }
function previousDate(value) { const d = new Date(value+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }
function periodList(db, day) { const row = db.prepare('SELECT periods FROM calendar WHERE date=?').get(day); if (row) return JSON.parse(row.periods); const dow = new Date(day+'T00:00:00Z').getUTCDay(); return dow === 0 || dow === 6 ? [] : allPeriods; }
function monthDates(month) { if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0,4)) < 1900) fail('Month must be YYYY-MM'); const count = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).getUTCDate(); return Array.from({length:count},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`); }
function threshold(db) { return Number(db.prepare("SELECT value FROM settings WHERE key='threshold'").get().value); }
function enrollments(db, classId) { return db.prepare('SELECT s.id,s.name,s.department,s.active,e.roll,e.start_date AS startDate,e.end_date AS endDate FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.class_id=? ORDER BY e.roll COLLATE NOCASE,s.id,e.start_date').all(classId); }
function report(db, classId, month) {
  const days = monthDates(month), limit = threshold(db);
  const records = db.prepare('SELECT student_id,date,period,status FROM attendance WHERE class_id=? AND date>=? AND date<=?').all(classId,days[0],days.at(-1));
  const marks = new Map(records.map(r=>[`${r.student_id}:${r.date}:${r.period}`,r.status]));
  const groups=new Map(); for(const s of enrollments(db,classId).filter(s=>s.startDate<=days.at(-1) && (!s.endDate || s.endDate>=days[0]))) { if(!groups.has(s.id)) groups.set(s.id,[]); groups.get(s.id).push(s); }
  return {month,threshold:limit,students:[...groups.values()].map(intervals=>{ intervals.sort((a,b)=>a.startDate.localeCompare(b.startDate)); const s=intervals.at(-1);
    let working=0,present=0,absent=0;
    for (const day of days) if (intervals.some(e=>day>=e.startDate && (!e.endDate || day<=e.endDate))) for (const p of periodList(db,day)) { working++; const mark=marks.get(`${s.id}:${day}:${p}`); if(mark==='P') present++; else if(mark==='A') absent++; }
    const unmarked=working-present-absent, complete=unmarked===0, raw=working ? present/working*100 : null;
    return {id:s.id,roll:s.roll,name:s.name,working,present,absent,unmarked,percentage:raw===null?null:Math.round((raw+Number.EPSILON)*100)/100,complete,low:working>0 && complete && raw<limit};
  })};
}
function csvCell(v) { let s = String(v ?? ''); if (/^[\s\u0000-\u001f]*[=+\-@\t\r]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; }
function createApp(db, opts = {}) {
  const app = express(), sessions = new Map(), loginFailures = new Map();
  const dummyHash = hashPassword('t13-demo-dummy-password-never-used');
  const loginWindowMs = 15*60*1000, loginLimit = 10;
  app.disable('x-powered-by'); app.use(express.json({limit:'1mb'}));
  app.use((req,res,next)=>{
    const apiPath = req.path.toLowerCase();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (apiPath.startsWith('/api/')) res.setHeader('Cache-Control','no-store');
    if (!apiPath.startsWith('/api/')) return next();
    const cookie = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='));
    let sid = cookie && cookie.slice(4), session = sid && sessions.get(sid);
    if (session && session.expires < Date.now()) { sessions.delete(sid); session = null; }
    if (!session) {
      if (sessions.size > 5000) for (const [key,value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
      sid = crypto.randomBytes(32).toString('hex'); session={csrf:crypto.randomBytes(32).toString('hex'),user:null,expires:Date.now()+8*3600*1000}; sessions.set(sid,session);
      res.setHeader('Set-Cookie',`sid=${sid}; Path=/; HttpOnly; SameSite=Strict${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
    }
    if(session.user) { const current=db.prepare('SELECT username,role,active FROM users WHERE id=?').get(session.user.id); if(!current || !current.active) session.user=null; else { session.user.username=current.username; session.user.role=current.role; } }
    req.session=session; req.sid=sid;
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && apiPath.startsWith('/api/') && req.get('X-CSRF-Token') !== session.csrf) return res.status(403).json({error:'Invalid CSRF token',code:'CSRF'});
    next();
  });
  const auth=(req,res,next)=>{ if(!req.session.user) return res.status(401).json({error:'Authentication required'}); next(); };
  const admin=(req,res,next)=>{ if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin access required'}); next(); };
  function access(req,classId) { if(!db.prepare('SELECT id FROM classes WHERE id=?').get(classId)) fail('Class not found',404); if(req.session.user.role!=='admin'&&!db.prepare('SELECT 1 FROM assignments WHERE user_id=? AND class_id=?').get(req.session.user.id,classId)) fail('Class access denied',403); }
  app.get('/health',(req,res)=>res.json({ok:true}));
  app.get('/api/session',(req,res)=>res.json({user:req.session.user,csrfToken:req.session.csrf}));
  app.post('/api/login',(req,res)=>{
    const username=text(req.body.username,'Username'), password=typeof req.body.password==='string'?req.body.password:'';
    const key=`${req.ip}|${username.toLowerCase()}`, now=Date.now(), attempt=loginFailures.get(key);
    if (attempt && attempt.count>=loginLimit && attempt.reset>now) { res.setHeader('Retry-After',String(Math.ceil((attempt.reset-now)/1000))); return res.status(429).json({error:'Too many sign-in attempts. Try again later.',code:'RATE_LIMITED'}); }
    if (attempt && attempt.reset<=now) loginFailures.delete(key);
    const u=db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const passwordValid=verifyPassword(password,u?u.password_hash:dummyHash);
    if(!u || !u.active || !passwordValid) { const next={count:(attempt?.count||0)+1,reset:(attempt&&attempt.reset>now)?attempt.reset:now+loginWindowMs}; loginFailures.set(key,next); if(loginFailures.size>1000) for(const [k,v] of loginFailures) if(v.reset<=Date.now()) loginFailures.delete(k); return res.status(401).json({error:'Invalid username or password'}); }
    loginFailures.delete(key);
    sessions.delete(req.sid);
    const sid=crypto.randomBytes(32).toString('hex'); const session={user:{id:u.id,username:u.username,role:u.role},csrf:crypto.randomBytes(32).toString('hex'),expires:Date.now()+8*3600*1000}; sessions.set(sid,session);
    res.setHeader('Set-Cookie',`sid=${sid}; Path=/; HttpOnly; SameSite=Strict${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
    res.json({user:session.user,csrfToken:session.csrf});
  });
  app.post('/api/logout',auth,(req,res)=>{ sessions.delete(req.sid); res.setHeader('Set-Cookie',`sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.COOKIE_SECURE==='true'?'; Secure':''}`); res.json({ok:true}); });
  app.get('/api/classes',auth,(req,res)=>{ const classes=req.session.user.role==='admin'?db.prepare('SELECT id,name FROM classes ORDER BY name').all():db.prepare('SELECT c.id,c.name FROM classes c JOIN assignments a ON a.class_id=c.id WHERE a.user_id=? ORDER BY c.name').all(req.session.user.id); res.json({classes}); });
  app.post('/api/classes',auth,admin,(req,res)=>{ const r=db.prepare('INSERT INTO classes(name) VALUES (?)').run(text(req.body.name,'Class name')); res.status(201).json({id:Number(r.lastInsertRowid)}); });
  app.put('/api/classes/:id',auth,admin,(req,res)=>{ const classId=id(req.params.id); if(!db.prepare('SELECT 1 FROM classes WHERE id=?').get(classId)) fail('Class not found',404); db.prepare('UPDATE classes SET name=? WHERE id=?').run(text(req.body.name,'Class name'),classId); res.json({ok:true}); });
  app.get('/api/users',auth,admin,(req,res)=>res.json({users:db.prepare('SELECT id,username,role,active FROM users ORDER BY username').all().map(u=>({...u,active:!!u.active}))}));
  app.post('/api/users',auth,admin,(req,res)=>{ const username=text(req.body.username,'Username'), password=req.body.password, role=req.body.role; if(typeof password!=='string'||password.length<12||password.length>256) fail('Password must be 12 to 256 characters'); if(!['admin','faculty'].includes(role)) fail('Role must be admin or faculty'); const r=db.prepare('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)').run(username,hashPassword(password),role); res.status(201).json({id:Number(r.lastInsertRowid)}); });
  app.put('/api/users/:id',auth,admin,(req,res)=>{ const userId=id(req.params.id), username=text(req.body.username,'Username'),role=req.body.role,active=req.body.active,password=req.body.password; if(!['admin','faculty'].includes(role)) fail('Role must be admin or faculty'); if(typeof active!=='boolean') fail('Active must be true or false'); if(password!==undefined && (typeof password!=='string'||password.length<12||password.length>256)) fail('Password must be 12 to 256 characters'); const prior=db.prepare('SELECT * FROM users WHERE id=?').get(userId); if(!prior) fail('User not found',404); transaction(db,()=>{ if(prior.active && prior.role==='admin' && (!active || role!=='admin') && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n<=1) fail('At least one active admin is required',409); db.prepare('UPDATE users SET username=?,role=?,active=?,password_hash=? WHERE id=?').run(username,role,active?1:0,password===undefined?prior.password_hash:hashPassword(password),userId); }); if(password!==undefined || prior.role!==role || !!prior.active!==active) for(const [key,s] of sessions) if(s.user?.id===userId) sessions.delete(key); res.json({ok:true}); });
  app.post('/api/assignments',auth,admin,(req,res)=>{ const userId=id(req.body.userId,'User ID'),classId=id(req.body.classId,'Class ID'); if(!db.prepare("SELECT id FROM users WHERE id=? AND role='faculty' AND active=1").get(userId)) fail('Active faculty account not found'); access(req,classId); db.prepare('INSERT OR IGNORE INTO assignments(user_id,class_id) VALUES (?,?)').run(userId,classId); res.json({ok:true}); });
  app.get('/api/assignments',auth,admin,(req,res)=>res.json({assignments:db.prepare('SELECT a.user_id AS userId,a.class_id AS classId,u.username,c.name AS className FROM assignments a JOIN users u ON u.id=a.user_id JOIN classes c ON c.id=a.class_id ORDER BY c.name,u.username').all()}));
  app.delete('/api/assignments',auth,admin,(req,res)=>{ const userId=id(req.body.userId,'User ID'),classId=id(req.body.classId,'Class ID'); db.prepare('DELETE FROM assignments WHERE user_id=? AND class_id=?').run(userId,classId); res.json({ok:true}); });
  app.get('/api/students',auth,(req,res)=>{ const classId=id(req.query.classId,'Class ID'); access(req,classId); const latest=new Map(); for(const s of enrollments(db,classId)) if(!latest.has(s.id) || latest.get(s.id).startDate<s.startDate) latest.set(s.id,s); res.json({students:[...latest.values()].map(s=>({...s,active:!!s.active}))}); });
  function studentInput(body) { const classId=id(body.classId,'Class ID'), roll=text(body.roll,'Roll',50), name=text(body.name,'Name',200),department=text(body.department,'Department',200),startDate=date(body.startDate,'Start date'),endDate=body.endDate?date(body.endDate,'End date'):null; if(endDate && endDate<startDate) fail('End date must not precede start date'); if(body.active!==undefined && typeof body.active!=='boolean') fail('Active must be true or false'); return {classId,roll,name,department,startDate,endDate,active:body.active!==false}; }
  function checkRoll(classId,roll,studentId=0) { if(db.prepare('SELECT 1 FROM enrollments WHERE class_id=? AND roll=? AND student_id<>?').get(classId,roll,studentId)) fail('Roll number is already used in this class',409); }
  app.post('/api/students',auth,admin,(req,res)=>{ const x=studentInput(req.body); access(req,x.classId); const studentId=transaction(db,()=>{ checkRoll(x.classId,x.roll); const r=db.prepare('INSERT INTO students(name,department,active) VALUES (?,?,?)').run(x.name,x.department,x.active?1:0); db.prepare('INSERT INTO enrollments(student_id,class_id,roll,start_date,end_date) VALUES (?,?,?,?,?)').run(r.lastInsertRowid,x.classId,x.roll,x.startDate,x.endDate); return Number(r.lastInsertRowid); }); res.status(201).json({id:studentId}); });
  app.put('/api/students/:id',auth,admin,(req,res)=>{ const studentId=id(req.params.id), x=studentInput(req.body); access(req,x.classId); transaction(db,()=>{
    if(!db.prepare('SELECT id FROM students WHERE id=?').get(studentId)) fail('Student not found',404);
    checkRoll(x.classId,x.roll,studentId); const existing=db.prepare('SELECT * FROM enrollments WHERE student_id=? ORDER BY start_date DESC').all(studentId); let target=existing[0]?.class_id===x.classId ? existing[0] : null;
    if (!target) { const current=existing[0]; if(!current || x.startDate<=current.start_date) fail('Transfer must begin after the previous enrollment starts'); const end=previousDate(x.startDate); if(current.end_date && current.end_date<end) { /* gap is allowed */ } else { if(db.prepare('SELECT 1 FROM attendance WHERE student_id=? AND class_id=? AND date>? LIMIT 1').get(studentId,current.class_id,end)) fail('Transfer would invalidate recorded attendance',409); db.prepare('UPDATE enrollments SET end_date=? WHERE id=?').run(end,current.id); } }
    for(const e of existing) if(!target || e.id!==target.id) { const effectiveEnd=(!target && e.id===existing[0].id && (!e.end_date || e.end_date>=x.startDate))?previousDate(x.startDate):e.end_date; if((!effectiveEnd || effectiveEnd>=x.startDate) && (!x.endDate || e.start_date<=x.endDate)) fail('Enrollment overlaps another class',409); }
    db.prepare('UPDATE students SET name=?,department=?,active=? WHERE id=?').run(x.name,x.department,x.active?1:0,studentId);
    if(target) db.prepare('UPDATE enrollments SET roll=?,start_date=?,end_date=? WHERE id=?').run(x.roll,x.startDate,x.endDate,target.id); else db.prepare('INSERT INTO enrollments(student_id,class_id,roll,start_date,end_date) VALUES (?,?,?,?,?)').run(studentId,x.classId,x.roll,x.startDate,x.endDate);
    if(db.prepare('SELECT 1 FROM attendance a WHERE a.student_id=? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=a.student_id AND e.class_id=a.class_id AND e.start_date<=a.date AND (e.end_date IS NULL OR e.end_date>=a.date)) LIMIT 1').get(studentId)) fail('Enrollment change would invalidate recorded attendance',409);
  }); res.json({ok:true}); });
  function daily(classId, day) {
    const periods=periodList(db,day), version=db.prepare('SELECT version FROM attendance_versions WHERE class_id=? AND date=?').get(classId,day)?.version || 0;
    const marks=db.prepare('SELECT student_id,period,status FROM attendance WHERE class_id=? AND date=?').all(classId,day);
    const byKey=new Map(marks.map(m=>[`${m.student_id}:${m.period}`,m.status]));
    const students=enrollments(db,classId).filter(s=>s.startDate<=day && (!s.endDate || s.endDate>=day)).map(s=>({id:s.id,roll:s.roll,name:s.name,statuses:Object.fromEntries(allPeriods.map(p=>[p,byKey.get(`${s.id}:${p}`)||'U']))}));
    return {classId,date:day,version,periods,students};
  }
  for (const route of ['/api/attendance','/api/history']) app.get(route,auth,(req,res)=>{ const classId=id(req.query.classId,'Class ID'),day=date(req.query.date); access(req,classId); res.json(daily(classId,day)); });
  app.put('/api/attendance',auth,(req,res)=>{ const classId=id(req.body.classId,'Class ID'),day=date(req.body.date); access(req,classId); if(day>today()) fail('Future attendance cannot be entered'); const version=req.body.version; if(!Number.isSafeInteger(version)||version<0) fail('Version must be a nonnegative integer'); if(!Array.isArray(req.body.entries)||req.body.entries.length>10000) fail('Entries must be an array of at most 10000 marks'); const reason=typeof req.body.reason==='string'?req.body.reason.trim():''; if(reason.length>500) fail('Reason must be at most 500 characters');
    const result=transaction(db,()=>{
      const current=db.prepare('SELECT version FROM attendance_versions WHERE class_id=? AND date=?').get(classId,day)?.version || 0;
      if(current!==version) fail('Attendance changed since it was loaded. Review and reload before saving.',409,'STALE_VERSION');
      const eligible=new Set(periodList(db,day)), seen=new Set(), changes=[];
      const member=db.prepare('SELECT s.active FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.student_id=? AND e.class_id=? AND e.start_date<=? AND (e.end_date IS NULL OR e.end_date>=?)');
      const old=db.prepare('SELECT status FROM attendance WHERE student_id=? AND class_id=? AND date=? AND period=?');
      for(const entry of req.body.entries) {
        if (!entry || typeof entry!=='object' || Array.isArray(entry)) fail('Each entry must be an object');
        const studentId=id(entry.studentId,'Student ID'), p=Number(entry.period); if(!Number.isInteger(p)||p<1||p>7) fail('Period must be from 1 to 7'); if(!eligible.has(p)) fail('Period is not eligible on this date'); if(!['P','A','U'].includes(entry.status)) fail('Status must be P, A, or U'); const key=`${studentId}:${p}`; if(seen.has(key)) fail('Duplicate student and period entry'); seen.add(key);
        const enrollment=member.get(studentId,classId,day,day), previous=old.get(studentId,classId,day,p); if(!enrollment) fail('Student is not eligible for this class and date');
        if(previous && previous.status!==entry.status && !reason) fail('A reason is required to correct saved attendance');
        if((previous && previous.status!==entry.status) || (!previous && entry.status!=='U')) changes.push({studentId,p,status:entry.status,previous:previous?.status});
      }
      const upsert=db.prepare('INSERT INTO attendance(student_id,class_id,date,period,status) VALUES (?,?,?,?,?) ON CONFLICT(student_id,class_id,date,period) DO UPDATE SET status=excluded.status');
      const audit=db.prepare('INSERT INTO attendance_audit(student_id,class_id,date,period,previous,value,reason,actor_id,timestamp) VALUES (?,?,?,?,?,?,?,?,?)');
      for(const c of changes) { upsert.run(c.studentId,classId,day,c.p,c.status); if(c.previous!==undefined) audit.run(c.studentId,classId,day,c.p,c.previous,c.status,reason,req.session.user.id,new Date().toISOString()); }
      db.prepare('INSERT INTO attendance_versions(class_id,date,version) VALUES (?,?,?) ON CONFLICT(class_id,date) DO UPDATE SET version=excluded.version').run(classId,day,current+1);
      return current+1;
    }); res.json({ok:true,version:result});
  });
  app.get('/api/audit',auth,(req,res)=>{ const classId=id(req.query.classId,'Class ID'),day=date(req.query.date); access(req,classId); const audit=db.prepare('SELECT a.student_id AS studentId,a.period,a.previous,a.value,a.reason,a.timestamp,u.username AS actor FROM attendance_audit a JOIN users u ON u.id=a.actor_id WHERE a.class_id=? AND a.date=? ORDER BY a.id').all(classId,day); res.json({audit}); });
  app.get('/api/settings',auth,(req,res)=>res.json({threshold:threshold(db),calendar:db.prepare('SELECT date,periods FROM calendar ORDER BY date').all().map(r=>({date:r.date,periods:JSON.parse(r.periods)}))}));
  app.put('/api/settings',auth,admin,(req,res)=>{ const n=req.body.threshold; if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100) fail('Threshold must be a number from 0 to 100'); db.prepare("UPDATE settings SET value=? WHERE key='threshold'").run(String(n)); res.json({ok:true}); });
  app.put('/api/calendar',auth,admin,(req,res)=>{ const day=date(req.body.date), periods=req.body.periods; if(!Array.isArray(periods)||periods.some(p=>!Number.isInteger(p)||p<1||p>7)||new Set(periods).size!==periods.length) fail('Periods must be unique numbers from 1 to 7'); transaction(db,()=>{ const recorded=db.prepare('SELECT DISTINCT period FROM attendance WHERE date=?').all(day); if(recorded.some(r=>!periods.includes(r.period))) fail('Calendar change would invalidate recorded attendance',409); db.prepare('INSERT INTO calendar(date,periods) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET periods=excluded.periods').run(day,JSON.stringify([...periods].sort((a,b)=>a-b))); }); res.json({ok:true}); });
  app.get(['/api/reports','/api/reports.csv'],auth,(req,res)=>{ const classId=id(req.query.classId,'Class ID'); access(req,classId); const data=report(db,classId,req.query.month); if(req.query.studentId!==undefined) { const studentId=id(req.query.studentId,'Student ID'); data.students=data.students.filter(s=>s.id===studentId); if(!data.students.length) fail('Student has no enrollment in this class and month',404); } if(req.path.endsWith('.csv')) { const header=['id','roll','name','working','present','absent','unmarked','percentage','complete','low']; const rows=[header,...data.students.map(s=>header.map(k=>s[k]===null?'N/A':k==='percentage'?s[k].toFixed(2):s[k]))]; res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="attendance-${data.month}.csv"`).send(rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n'); } else res.json(data); });
  if (opts.staticDir !== false) app.use(express.static(opts.staticDir || path.join(__dirname,'..','public')));
  app.use((err,req,res,next)=>{ if(res.headersSent) return next(err); const triggerAbort=err.errcode===1811 || /already used in this class|overlaps another interval|constraint failed/i.test(String(err.message||'')); if((err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) || (err.code==='ERR_SQLITE_ERROR' && triggerAbort)) return res.status(409).json({error:'A record with these unique values already exists or a reference is invalid',code:'CONSTRAINT'}); if(err.status) return res.status(err.status).json({error:err.message,...(err.code?{code:err.code}:{})}); if(err instanceof SyntaxError && err.status===400) return res.status(400).json({error:'Invalid JSON'}); console.error('Request failed:',err.message); res.status(500).json({error:'Internal server error'}); });
  return app;
}
module.exports = { createApp, report, periodList, today, csvCell };
