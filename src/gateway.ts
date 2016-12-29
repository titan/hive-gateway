import * as http from "http";
import * as crypto from "crypto";
import * as msgpack from "msgpack-lite";
import * as nanomsg from "nanomsg";
import * as bunyan from "bunyan";
import * as Redis from "redis";
import * as zlib from "zlib";

const domain = process.argv.filter(x => x === "admin").length > 0 ? "admin" : "mobile";

let log = bunyan.createLogger({
  name: "gateway",
  streams: [
    {
      level: "info",
      path: `/var/log/gateway-${domain}-info.log`,
      type: "rotating-file",
      period: "1d",   // daily rotation
      count: 7        // keep 7 back copies
    },
    {
      level: "error",
      path: `/var/log/gateway-${domain}-error.log`,
      type: "rotating-file",
      period: "1w",   // daily rotation
      count: 3        // keep 7 back copies
    }
  ]
});

const authorize_url = process.env["AUTHORIZE-URL"];

const redis = Redis.createClient(process.env["CACHE_PORT"] ? parseInt(process.env["CACHE_HOST"]) : 6379, process.env["CACHE_HOST"]);

const sessions = {};

const servermap = ["oss", "plan", "profile", "quotation", "wallet", "vehicle", "order", "mutual_aid", "group", "checkcode", "bank_payment", "operator", "underwrite", "cashout"].reduce((acc, svc) => {
  const addr = process.env[svc.toUpperCase()];
  if (addr) {
    acc[svc] = addr;
  }
  return acc;
}, {});

const routes = Object.keys(servermap).reduce((acc, mod) => {
  const addr = servermap[mod];
  if (addr) {
    if (domain === "mobile") {
      const request = nanomsg.socket("pair", { sndtimeo: 5000, rcvtimeo: 30000 });
      const lastnumber = parseInt(addr[addr.length - 1]) + 1;
      const newaddr = addr.substr(0, addr.length - 1) + lastnumber.toString();
      request.connect(domain === "mobile" ? newaddr : addr);
      request.on("data", on_service_response);
      acc[mod] = request;
    } else {
      acc[mod] = addr;
    }
  }
  return acc;
}, {});

function response_to_client(sn: string, rep: http.ServerResponse, data: Buffer, compressed?: string): void {
  rep.writeHead(200, compressed ? (compressed === "deflate" ? { "Content-Type": "application/octet-stream", "Content-Encoding": "deflate" } : { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" }) : { "Content-Type": "application/octet-stream" });
  rep.write(data);
  rep.end();
  if (sessions[sn]["req"]) {
    sessions[sn]["req"].close();
  }
  delete sessions[sn];
}

function on_service_response(msg) {
  const data: Object = msgpack.decode(msg);
  const session = sessions[data["sn"]];
  if (session && session["rep"]) {
    const rep = session["rep"];
    const encoding: string = session["encoding"];
    const start: number = session["start"];
    const stop: number = new Date().getTime();
    const info: string = session["info"];
    log.info(`${info} done in ${stop - start} milliseconds`);
    if (data["payload"][0] === 0x78 && data["payload"][1] === 0x9c) {
      if (encoding.match(/\bdeflate\b/)) {
        response_to_client(data["sn"], rep, data["payload"], "deflate");
      } else {
        zlib.inflate(data["payload"], (err: Error, payload: Buffer) => {
          if (err) {
            log.error(err);
            delete sessions[data["sn"]];
            rep.writeHead(500, {"Content-Type": "text/plain"});
            rep.write("Inflate response error");
            rep.end();
          } else {
            if (encoding.match(/\bgzip\b/)) {
              zlib.gzip(payload, (err: Error, buf: Buffer) => {
                if (err) {
                  response_to_client(data["sn"], rep, payload);
                } else {
                  response_to_client(data["sn"], rep, buf, "gzip");
                }
              });
            } else {
              response_to_client(data["sn"], rep, payload);
            }
          }
        });
      }
    } else {
      const payload: Buffer = data["payload"];
      if (payload.length > 1024) {
        if (encoding.match(/\bdeflate\b/)) {
          zlib.deflate(payload, (err: Error, buf: Buffer) => {
            if (err) {
              response_to_client(data["sn"], rep, payload);
            } else {
              response_to_client(data["sn"], rep, buf, "deflate");
            }
          });
        } else if (encoding.match(/\bgzip\b/)) {
          zlib.gzip(payload, (err: Error, buf: Buffer) => {
            if (err) {
              response_to_client(data["sn"], rep, payload);
            } else {
              response_to_client(data["sn"], rep, buf, "gzip");
            }
          });
        } else {
          response_to_client(data["sn"], rep, payload);
        }
      } else {
        response_to_client(data["sn"], rep, payload);
      }
    }
  } else {
    console.error(`Response ${data["sn"]} not found`);
  }
}

function limit_api_call(token: String, cb: ((result: boolean) => void)): void {
  const key = "ratelimit:" + token;
  redis.llen(key, (e: Error, current: number) => {
    if (e) {
      cb(false);
    } else if (current < 10) {
      redis.exists(key, (e: Error, exists: boolean) => {
        if (exists) {
          const multi = redis.multi();
          multi.rpush(key, token);
          multi.expire(key, 1);
          multi.exec((e: Error, _: any) => {
            if (e) {
              cb(false);
            } else {
              cb(true);
            }
          });
        } else {
          redis.rpushx(key, token, (e: Error, _: any) => {
            if (e) {
              cb(false);
            } else {
              cb(true);
            }
          });
        }
      });
    } else {
      cb(false);
    }
  });
}

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

      const token = ctx ? ctx.wxuser : null;

      const route = routes[mod];

      if (route) {
        let uid = "";
        if (token) {
          limit_api_call(token, (allow: boolean) => {
            if (allow) {
              if (token.length === 28) {
                redis.hget("wxuser", token, (err, reply) => {
                  if (!err) {
                    uid = reply;
                  } else {
                    log.error(err);
                  }
                  if (uid && uid.length > 0) {
                    const params = {
                      ctx: { domain: domain, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, uid: uid },
                      fun: fun,
                      args: arg
                    };
                    const acceptEncoding = req.headers["accept-encoding"];
                    call(acceptEncoding ? acceptEncoding : "", route, mod, params, rep);
                  } else {
                    log.info("User is not authorized by wechat");
                    rep.writeHead(307, {"Content-Type": "text/plain"});
                    rep.end(authorize_url);
                  }
                });
              } else {
                redis.get("sessions:" + token, (err, reply) => {
                  if (!err) {
                    uid = reply;
                  } else {
                    log.error(err);
                  }
                  if (uid && uid.length > 0) {
                    const params = {
                      ctx: { domain: domain, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, uid: uid },
                      fun: fun,
                      args: arg
                    };
                    const acceptEncoding = req.headers["accept-encoding"];
                    call(acceptEncoding ? acceptEncoding : "", route, mod, params, rep);
                  } else {
                    log.info("User is not authorized by wechat");
                    rep.writeHead(307, {"Content-Type": "text/plain"});
                    rep.end(authorize_url);
                  }
                });
              }
            } else {
              log.info("token %s too many requests", token);
              rep.writeHead(429, {"Content-Type": "text/plain"});
              rep.end("Too Many Requests");
            }
          });
        } else {
          if (domain === "admin") {
            limit_api_call("anonymous", (allow: boolean) => {
              if (allow) {
                const params = {
                  ctx: { domain: domain, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, uid: uid },
                  fun: fun,
                  args: arg
                };
                const acceptEncoding = req.headers["accept-encoding"];
                call(acceptEncoding ? acceptEncoding : "", route, mod, params, rep);
              } else {
                log.info("anonymous too many requests");
                rep.writeHead(429, {"Content-Type": "text/plain"});
                rep.end("Too Many Requests");
              }
            });
          } else {
            log.info("User is not authorized by wechat");
            rep.writeHead(307, {"Content-Type": "text/plain"});
            rep.end(authorize_url);
          }
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

function call (acceptEncoding: string, socket, mod: string, params, rep) {
  const addr = servermap[mod];
  const sn = crypto.randomBytes(64).toString("base64");
  const paramstr = JSON.stringify(params.args);
  const info = `call ${mod}.${params.fun} ${paramstr} to ${addr} with sn ${sn}`;
  log.info(info);
  const data = msgpack.encode({sn, pkt: params});
  sessions[sn] = {
    encoding: acceptEncoding,
    rep,
    start: new Date().getTime(),
    info
  };
  if (domain === "mobile") {
    socket.send(data);
  } else {
    const request = nanomsg.socket("req");
    request.connect(addr);
    request.send(data);
    request.on("data", on_service_response);
    sessions[sn]["req"] = request;
  }
}

const portkey = "GATEWAY-" + domain.toUpperCase() + "-PORT";
const port = process.env[portkey] ? parseInt(process.env[portkey]) : 8000;

log.info(`API gateway is listening on port: ${port}`);
server.listen(port);
