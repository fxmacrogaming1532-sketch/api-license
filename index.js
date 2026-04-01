const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API online");
});

app.post("/validate", (req, res) => {
  const { licenseId, hwid } = req.body;

  if (!licenseId || !hwid) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  if (licenseId === "TESTE123") {
    return res.json({ ok: true });
  }

  return res.status(403).json({ ok: false, error: "invalid_license" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
});
