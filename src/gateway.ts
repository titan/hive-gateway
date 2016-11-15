import * as http from "http";
import * as crypto from "crypto";
import * as msgpack from "msgpack-lite";
import * as nanomsg from "nanomsg";
import * as bunyan from "bunyan";
import * as Redis from "redis";
import * as zlib from "zlib";
import { servermap } from "hive-hostmap";

let log = bunyan.createLogger({
  name: "gateway",
  streams: [
    {
      level: "info",
      path: "/var/log/gateway-info.log",  // log ERROR and above to a file
      type: "rotating-file",
      period: "1d",   // daily rotation
      count: 7        // keep 7 back copies
    },
    {
      level: "error",
      path: "/var/log/gateway-error.log",  // log ERROR and above to a file
      type: "rotating-file",
      period: "1w",   // daily rotation
      count: 3        // keep 7 back copies
    }
  ]
});

const redis = Redis.createClient(process.env["CACHE_PORT"] ? parseInt(process.env["CACHE_HOST"]) : 6379, process.env["CACHE_HOST"]);

const sessions = {};

const routes = Object.keys(["oss"].reduce((acc, svc) => {
  const addr = process.env[svc.toUpperCase()];
  if (addr) {
    acc[svc] = addr;
  }
  return acc;
}, servermap)).reduce((acc, mod) => {
  const addr = servermap[mod];
  if (addr) {
    const request = nanomsg.socket("pair", { sndtimeo: 5000, rcvtimeo: 30000 });
    const lastnumber = parseInt(addr[addr.length - 1]) + 1;
    const newaddr = addr.substr(0, addr.length - 1) + lastnumber.toString();
    request.connect(newaddr);
    request.on("data", (msg) => {
      const data: Object = msgpack.decode(msg);
      const pair = sessions[data["sn"]];
      if (pair && pair["rep"]) {
        const rep = pair["rep"];
        const encoding: string = pair["encoding"];
        const payload: Buffer = data["payload"];
        if (payload.length > 1024) {
          if (encoding.match(/\bdeflate\b/)) {
            zlib.deflate(payload, (err: Error, buf: Buffer) => {
              if (err) {
                rep.writeHead(200, { "Content-Type": "application/octet-stream"});
                rep.write(payload);
                rep.end();
                delete sessions[data["sn"]];
              } else {
                rep.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Encoding": "deflate" });
                rep.write(buf);
                rep.end();
                delete sessions[data["sn"]];
              }
            });
          } else if (encoding.match(/\bgzip\b/)) {
            zlib.gzip(payload, (err: Error, buf: Buffer) => {
              if (err) {
                rep.writeHead(200, { "Content-Type": "application/octet-stream"});
                rep.write(payload);
                rep.end();
                delete sessions[data["sn"]];
              } else {
                rep.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" });
                rep.write(buf);
                rep.end();
                delete sessions[data["sn"]];
              }
            });
          } else {
            rep.writeHead(200, {"Content-Type": "application/octet-stream"});
            rep.write(payload);
            rep.end();
            delete sessions[data["sn"]];
          }
        } else {
          rep.writeHead(200, {"Content-Type": "application/octet-stream"});
          rep.write(payload);
          rep.end();
          delete sessions[data["sn"]];
        }
      } else {
        console.error(`Response ${data["sn"]} not found`);
      }
    });
    acc[mod] = request;
  }
  return acc;
}, {});

// create and start http server
let server = http.createServer((req, rep) => {
  if (req.headers.origin) {
    rep.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  } else {
    rep.setHeader("Access-Control-Allow-Origin", "*");
  }
  rep.setHeader("Access-Control-Allow-Credentials", "true");
  rep.setHeader("Access-Control-Allow-Methods", "POST");

  if (req.method === "POST") {
    let chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const data = msgpack.decode(Buffer.concat(chunks));
      const mod = data.mod;
      const fun = data.fun;
      const arg = data.arg;
      const ctx = data.ctx;

      let openid = ctx ? ctx.wxuser : null;

      let route = routes[mod];

      if (route) {
        let uid = "";
        if (openid) {
          redis.hget("wxuser", openid, (err, reply) => {
            if (!err) {
              uid = reply;
            }
            let params = {
              ctx: { domain: "mobile", ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, uid: uid },
              fun: fun,
              args: arg
            };
            const acceptEncoding = req.headers["accept-encoding"];
            call(acceptEncoding ?  acceptEncoding : "", route, mod, params, rep);
          });
        } else {
          let params = {
            ctx: { domain: "mobile", ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, uid: uid },
            fun: fun,
            args: arg
          };
          const acceptEncoding = req.headers["accept-encoding"];
          call(acceptEncoding ?  acceptEncoding : "", route, mod, params, rep);
        }
      } else {
        log.info("%s.%s %s not found", mod, fun, JSON.stringify(arg));
        rep.writeHead(404, {"Content-Type": "text/plain"});
        rep.end("Module not found");
      }
    });
  } else {
    log.info("%s %s invalid rpc call", req.method, req.url);
    rep.writeHead(405, {"Content-Type": "text/plain"});
    rep.end("Invalid rpc call");
  }
});

function call (acceptEncoding, socket, mod, params, rep) {
  const addr = servermap[mod];
  const sn = crypto.randomBytes(64).toString("base64");
  log.info("call %s.%s %s to %s", mod, params.fun, JSON.stringify(params.args), addr);
  const data = msgpack.encode({sn, pkt: params});
  socket.send(data);
  sessions[sn] = {
    encoding: acceptEncoding,
    rep
  };
}

log.info("API gateway is listening on port: 8000");
server.listen(8000);
