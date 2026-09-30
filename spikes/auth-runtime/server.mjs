import http from 'node:http';
import { createAuth } from './auth.mjs';
import { Fault, store } from './store.mjs';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const attemptPath = new RegExp(`^/api/v1/attempts/(${uuid})$`, 'i');
const submitPath = new RegExp(`^/api/v1/attempts/(${uuid})/submissions$`, 'i');
const retryPath = new RegExp(`^/api/v1/submissions/(${uuid})/retry$`, 'i');
const resultPath = new RegExp(`^/api/v1/submissions/(${uuid})$`, 'i');
const authRoutes = new Set(['POST /api/auth/sign-up/email','POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out','GET /api/auth/get-session']);
export async function start(pool, secret) {
  const records = store(pool);
  let auth, baseURL;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (!auth || !baseURL) return send(503,{error:'starting'});
      const path = new URL(req.url,baseURL).pathname;
      const route = `${req.method} ${path}`;
      if (route === 'GET /api/health') return send(200,{ status:'local-spike', contractVersion:'0.1.0' });
      if (req.method !== 'GET' && req.headers.origin !== baseURL) throw new Fault(403,'origin_rejected');
      let text = '';
      if (req.method !== 'GET') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Fault(415,'json_required');
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req.iterator({destroyOnReturn:false})) {
          bytes += chunk.length;
          if (bytes > 65536) { req.resume(); throw new Fault(413,'body_too_large'); }
          chunks.push(chunk);
        }
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)); }
        catch { throw new Fault(400,'invalid_utf8'); }
      }
      const headers = new Headers();
      for (const [k,v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k,v);
      if (authRoutes.has(route)) {
        const response = await auth.handler(new Request(baseURL+path,{ method:req.method,headers, ...(text ? {body:text} : {}) }));
        res.statusCode = response.status;
        for (const [k,v] of response.headers) if (k !== 'set-cookie') res.setHeader(k,v);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader('Set-Cookie',cookies);
        res.setHeader('Cache-Control','no-store');
        return res.end(await response.text());
      }
      const session = await auth.api.getSession({headers});
      if (!session) throw new Fault(401,'unauthenticated');
      const owner = session.user.id;
      let body = {};
      try { if (text) body = JSON.parse(text); } catch { throw new Fault(400,'invalid_json'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Fault(422,'invalid_body');
      const fields = allowed => { if(Object.keys(body).some(k => !allowed.includes(k))) throw new Fault(422,'unknown_field'); };
      if (route === 'GET /api/v1/account') return send(200,{contractVersion:'0.1.0',id:owner,email:session.user.email});
      if (route === 'POST /api/v1/attempts') {
        fields(['parentSubmissionId']);
        if (body.parentSubmissionId !== undefined &&
            (typeof body.parentSubmissionId !== 'string' || !new RegExp(`^${uuid}$`,'i').test(body.parentSubmissionId))) throw new Fault(422,'invalid_parent');
        return send(201,await records.create(owner,body.parentSubmissionId));
      }
      const a = attemptPath.exec(path), s = submitPath.exec(path), r = retryPath.exec(path);
      const result = resultPath.exec(path);
      if (result && req.method === 'GET') return send(200,await records.result(owner,result[1]));
      if (a && req.method === 'GET') return send(200,await records.read(owner,a[1]));
      if (a && req.method === 'PUT') { fields(['expectedRevision','text']); return send(200,await records.save(owner,a[1],body.expectedRevision,body.text)); }
      if (a && req.method === 'DELETE') { fields([]); await records.remove(owner,a[1]); return send(200,{deleted:true}); }
      if (s && req.method === 'POST') { fields(['expectedRevision','eventId']); return send(202,await records.submit(owner,s[1],body.expectedRevision,body.eventId)); }
      if (r && req.method === 'POST') { fields([]); await records.retry(owner,r[1]); return send(202,{queued:true}); }
      throw new Fault(404,'not_found');
    } catch(e) { send(e instanceof Fault ? e.status : 500,{error:e instanceof Fault ? e.code : 'internal_error'}); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  auth = createAuth(pool,baseURL,secret);
  return {baseURL,auth,records,close:()=>new Promise(resolve=>server.close(resolve))};
}
