import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

def _migrate(path):
    with sqlite3.connect(path) as database:
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("CREATE TABLE IF NOT EXISTS subscriptions(tenant TEXT NOT NULL,id TEXT NOT NULL,amount_cents INTEGER NOT NULL,idempotency_key TEXT NOT NULL,PRIMARY KEY(tenant,id),UNIQUE(tenant,idempotency_key))")
        database.execute("PRAGMA user_version=1")

def run(*, host, port, database_path):
    _migrate(database_path)
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status, body):
            payload=json.dumps(body,separators=(",",":"),sort_keys=True).encode(); self.send_response(status); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(payload))); self.end_headers(); self.wfile.write(payload)
        def do_GET(self):
            if self.path == "/health": return self._reply(200,{"status":"ready","schemaVersion":1})
            parts=self.path.split("?")[0].strip("/").split("/")
            if len(parts)==4 and parts[0]=="tenants" and parts[2]=="subscriptions":
                tenant,subscription_id=unquote(parts[1]),unquote(parts[3])
                with sqlite3.connect(database_path) as database: row=database.execute("SELECT amount_cents FROM subscriptions WHERE tenant=? AND id=?",(tenant,subscription_id)).fetchone()
                return self._reply(200,{"tenant":tenant,"id":subscription_id,"amount_cents":row[0]}) if row else self._reply(404,{"error":"NotFound"})
            self._reply(404,{"error":"NotFound"})
        def do_POST(self):
            if self.path == "/admin/migrate": _migrate(database_path); return self._reply(200,{"schemaVersion":1})
            if self.path != "/subscriptions": return self._reply(404,{"error":"NotFound"})
            body=json.loads(self.rfile.read(int(self.headers.get("content-length","0"))))
            try:
                with sqlite3.connect(database_path,timeout=5,isolation_level=None) as database:
                    database.execute("BEGIN IMMEDIATE"); prior=database.execute("SELECT id,amount_cents FROM subscriptions WHERE tenant=? AND idempotency_key=?",(body["tenant"],body["idempotency_key"])).fetchone()
                    if prior and (prior[0]!=body["id"] or prior[1]!=body["amount_cents"]): database.rollback(); return self._reply(409,{"error":"IdempotencyConflict"})
                    database.execute("INSERT OR IGNORE INTO subscriptions VALUES(?,?,?,?)",(body["tenant"],body["id"],body["amount_cents"],body["idempotency_key"])); database.commit()
                self._reply(200,{"tenant":body["tenant"],"id":body["id"],"amount_cents":body["amount_cents"]})
            except (KeyError,TypeError,ValueError): self._reply(400,{"error":"InvalidRequest"})
        def log_message(self, format, *args): pass
    ThreadingHTTPServer((host,port),Handler).serve_forever()
