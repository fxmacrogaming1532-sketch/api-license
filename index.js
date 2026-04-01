const express = require("express");
const app = express();

app.use(express.json());

app.post("/validate", (req, res) => {
  const { licenseId, hwid } = req.body;

  if (!licenseId || !hwid) {
    return res.status(400).json({ ok: false });
  }

  if (licenseId === "TESTE123") {
    return res.json({ ok: true });
  }

  return res.status(403).json({ ok: false });
});

app.listen(3000, () => {
  console.log("Server rodando");
});
