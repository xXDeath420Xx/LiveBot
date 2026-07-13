process.env.EPIC_OAUTH_CLIENT_ID = 'xyzclient123';
process.env.EPIC_OAUTH_CLIENT_SECRET = 'secret456';
process.env.DASHBOARD_URL = 'https://certifriedmultitool.com';
import express from 'express';
const r = (await import('./dashboard/routes/sprites.js')).default;
const app = express();
app.use((req,_res,next)=>{ req.session={}; next(); });
app.use('/sprites', r);
const srv = app.listen(0); const port = srv.address().port;
// 1) login page shows the button + paste fallback details
const login = await (await fetch(`http://localhost:${port}/sprites`)).text();
console.log('login: has Epic button:', login.includes('/sprites/connect'), '| has paste fallback:', login.includes('Or paste a code'));
// 2) /connect builds the authorize redirect
const c = await fetch(`http://localhost:${port}/sprites/connect`, { redirect:'manual' });
const loc = c.headers.get('location');
console.log('/connect ->', c.status);
console.log('  authorize URL:', loc);
const u = new URL(loc);
console.log('  client_id:', u.searchParams.get('client_id'), '| redirect_uri:', u.searchParams.get('redirect_uri'), '| has state:', !!u.searchParams.get('state'), '| host:', u.host+u.pathname);
srv.close();
