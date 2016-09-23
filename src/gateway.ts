import * as http from 'http';
import * as msgpack from 'msgpack-lite';
import * as nanomsg from 'nanomsg';
import * as bunyan from 'bunyan';
import * as Redis from 'redis';
import { servermap } from 'hive-hostmap';

let log = bunyan.createLogger({
  name: 'gateway',
  streams: [
    {
      level: 'info',
      path: '/var/log/gateway-info.log',  // log ERROR and above to a file
      type: 'rotating-file',
      period: '1d',   // daily rotation
      count: 7        // keep 7 back copies
    },
    {
      level: 'error',
      path: '/var/log/gateway-error.log',  // log ERROR and above to a file
      type: 'rotating-file',
      period: '1w',   // daily rotation
      count: 3        // keep 7 back copies
    }
  ]
});

let routes = servermap;

let redis = Redis.createClient(6379, process.env['CACHE_HOST']);

// create and start http server
let server = http.createServer((req, rep) => {
  if (req.headers.origin) {
    rep.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  } else {
    rep.setHeader('Access-Control-Allow-Origin', '*');
  }
  rep.setHeader('Access-Control-Allow-Credentials', 'true');
  rep.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method == 'POST') {
    let chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const data = msgpack.decode(Buffer.concat(chunks));
      const mod = data.mod;
      const fun = data.fun;
      const arg = data.arg;
      const ctx = data.ctx;

      let openid = ctx? ctx.wxuser: null;

      let route = routes[mod];

      if (route) {
        let uid = '';
        if (openid) {
          redis.hget('wxuser', openid, (err, reply) => {
            if (!err) {
              uid = reply;
            }
            let params = {
              ctx: { domain: 'mobile', ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, uid: uid },
              fun: fun,
              args: arg
            };
            call(route, mod, params, rep);
          });
        } else {
          let params = {
            ctx: { domain: 'mobile', ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, uid: uid },
            fun: fun,
            args: arg
          };
          call(route, mod, params, rep);
        }
      } else {
        log.info('%s.%s %s not found', mod, fun, JSON.stringify(arg));
        rep.writeHead(404, {'Content-Type': 'text/plain'});
        rep.end('Module not found');
      }
    });
  } else {
    log.info('%s %s invalid rpc call', req.method, req.url);
    rep.writeHead(405, {'Content-Type': 'text/plain'});
    rep.end('Invalid rpc call');
  }
});

function call (route, mod, params, rep) {
  let addr = route
  log.info({params: params}, 'call %s.%s %s to %s', mod, params.fun, JSON.stringify(params.args), addr);
  let request = nanomsg.socket('req');
  request.connect(addr);
  request.send(msgpack.encode(params));
  request.on('data', (msg) => {
    rep.writeHead(200, {'Content-Type': 'application/octet-stream'});
    rep.write(msg);
    rep.end();
    request.close();
  });
}

log.info('API gateway is listening on port: 8000');
server.listen(8000);
