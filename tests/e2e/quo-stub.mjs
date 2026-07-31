// Stand-in for the Quo API so the whole pipeline can be exercised without
// sending real texts. Records everything it is asked to send.
import http from "node:http";
const sent = [];
const numbers = [
  { id: "PNINTAKE", number: "+15125557777", name: "Intake line" },
  { id: "PNSPARE", number: "+15125558888", name: "Spanish line" },
];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url.startsWith("/v1/phone-numbers")) {
      res.writeHead(200, {"content-type":"application/json"});
      return res.end(JSON.stringify({ data: numbers }));
    }
    if (req.url.startsWith("/v1/messages") && req.method === "POST") {
      const parsed = JSON.parse(body);
      const id = `MSG${sent.length + 1}`;
      sent.push({ id, ...parsed });
      res.writeHead(202, {"content-type":"application/json"});
      return res.end(JSON.stringify({ data: { id, status: "queued" } }));
    }
    if (req.url.startsWith("/__sent")) {
      res.writeHead(200, {"content-type":"application/json"});
      return res.end(JSON.stringify(sent));
    }
    res.writeHead(404); res.end("{}");
  });
}).listen(4999, () => console.log("quo stub on 4999"));
