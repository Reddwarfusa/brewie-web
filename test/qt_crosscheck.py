"""Cross-check the JS codecs against real Qt 5 (PyQt5)."""
import sys, json, subprocess, base64, zlib
from PyQt5.QtCore import QJsonDocument, QByteArray, QDataStream, QIODevice, QVariant, qCompress, qUncompress
JS = sys.argv[1]
sample = {"id":"abc-123","name":"Ünïcode IPA ☕","batchSize":20,"efficiency":72.5,"neg":-5,"big":123456789012,
          "mash":{"mashInWater":14.5,"mashInTemperature":67,"mashSteps":[[{"stepTemp":64,"stepTime":45},{"stepTemp":72,"stepTime":15}]]},
          "hops":[{"name":"Citra","amount":25,"alpha":12.5,"time":60,"cage":1}],"empty":[],"emptyObj":{},"t":True,"f":False,"n":None}
def js(cmd, payload):
    r = subprocess.run(["node", JS, cmd], input=payload, capture_output=True, check=True)
    return r.stdout
ok = True
# 1) JS qbjs -> Qt
b = base64.b64decode(js("qbjs-encode", json.dumps(sample).encode()))
doc = QJsonDocument.fromBinaryData(QByteArray(b))
if doc.isNull(): print("FAIL: Qt rejected JS binary JSON"); ok = False
else:
    back = json.loads(bytes(doc.toJson()).decode())
    if back != sample: print("FAIL qbjs JS->Qt mismatch", back); ok=False
    else: print("ok  qbjs JS->Qt")
# 2) Qt qbjs -> JS
qb = bytes(QJsonDocument.fromJson(json.dumps(sample).encode()).toBinaryData())
out = json.loads(js("qbjs-decode", base64.b64encode(qb)))
print("ok  qbjs Qt->JS" if out == sample else ("FAIL qbjs Qt->JS %r" % out)); ok &= out == sample
# 3) qCompress interop
qc = bytes(qCompress(QByteArray(b"hello brewie"*20)))
print("ok  qUncompress(Qt)" if js("quncompress", base64.b64encode(qc)) == b"hello brewie"*20 else "FAIL qUncompress")
jc = base64.b64decode(js("qcompress", b"hello brewie"*20))
print("ok  qCompress(JS)->Qt" if bytes(qUncompress(QByteArray(jc))) == b"hello brewie"*20 else "FAIL qCompress")
# 4) QDataStream message frame JS -> Qt
frame = base64.b64decode(js("frame", b'{"type":300,"data":{"id":"x","isWaterInlet":true,"isCooling":false}}'))
ba = QByteArray(frame[4:]); s = QDataStream(ba, QIODevice.ReadOnly)
n = s.readInt32(); m = {}
for _ in range(n):
    k = s.readQString(); v = s.readQVariant(); m[k] = v
good = int.from_bytes(frame[:4],'big') == len(frame)-4 and m == {"type":300,"data":{"id":"x","isWaterInlet":True,"isCooling":False}} and s.atEnd()
print("ok  frame JS->Qt" if good else "FAIL frame %r" % m); ok &= good
# 5) Qt -> JS : build a map with Qt and decode in JS
ba = QByteArray(); s = QDataStream(ba, QIODevice.WriteOnly)
qm = {"type": QVariant(201), "data": QVariant("3\t1200\t300\t900\tV7\t1000\t14.5\t65.2\t20.1\t652\t201\t0\t0\t0\t0\t0\t0\t1\t0\t30\t\t230\t0\t99.8\t20\t0\t0")}
s.writeInt32(len(qm))
for k in sorted(qm, reverse=True): s.writeQString(k); s.writeQVariant(qm[k])
inner = bytes(ba); framed = len(inner).to_bytes(4,'big') + inner
out = json.loads(js("unframe", base64.b64encode(framed)))
good = out == [{"type":201,"data":qm["data"].value()}]
print("ok  frame Qt->JS" if good else "FAIL unframe %r" % out); ok &= good
# 6) LongLong + bytearray variants
ba = QByteArray(); s = QDataStream(ba, QIODevice.WriteOnly)
s.writeInt32(2); s.writeQString("time"); s.writeQVariant(QVariant(1731790000123)); s.writeQString("blob"); s.writeQVariant(QVariant(QByteArray(b"\x00\x01\x02")))
inner=bytes(ba); out=json.loads(js("unframe", base64.b64encode(len(inner).to_bytes(4,'big')+inner)))
good = out==[{"time":1731790000123,"blob":{"type":"Buffer","data":[0,1,2]}}]
print("ok  longlong/bytearray" if good else "FAIL %r"%out); ok&=good
sys.exit(0 if ok else 1)
