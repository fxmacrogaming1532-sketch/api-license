const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return value;
}

const FIREBASE_PROJECT_ID = requireEnv("FIREBASE_PROJECT_ID");
const FIREBASE_CLIENT_EMAIL = requireEnv("FIREBASE_CLIENT_EMAIL");
const FIREBASE_PRIVATE_KEY = requireEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY,

      // compatibilidade extra
      project_id: FIREBASE_PROJECT_ID,
      client_email: FIREBASE_CLIENT_EMAIL,
      private_key: FIREBASE_PRIVATE_KEY,
    }),
    databaseURL: "https://fx-store---banco-de-dados-default-rtdb.firebaseio.com",
  });
}

const db = admin.firestore();
const rtdb = admin.database();

function nowMs() {
  return Date.now();
}

function toDateSafe(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isExpired(expiresAt) {
  const d = toDateSafe(expiresAt);
  if (!d) return false;
  return d.getTime() <= Date.now();
}

function maskKey(key) {
  if (!key) return "";
  return key.slice(0, 16);
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function generateLicenseKey(prefix = "FXS") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const randomPart = (len) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${prefix}-${randomPart(4)}-${randomPart(4)}-${randomPart(4)}-${randomPart(4)}`;
}

async function getPlanById(planId) {
  const snap = await db.collection("plans").doc(String(planId)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function findLicenseByInput(licenseInput) {
  const docRef = db.collection("licenses").doc(String(licenseInput));
  const docSnap = await docRef.get();

  if (docSnap.exists) {
    return {
      id: docSnap.id,
      ref: docRef,
      data: docSnap.data(),
    };
  }

  const hash = sha256(String(licenseInput));
  const querySnap = await db.collection("licenses").where("keyHash", "==", hash).limit(1).get();

  if (querySnap.empty) return null;

  const doc = querySnap.docs[0];
  return {
    id: doc.id,
    ref: doc.ref,
    data: doc.data(),
  };
}

async function getOnlineState(clientId) {
  if (!clientId) return null;
  const snap = await rtdb.ref(`status/${clientId}`).get();
  return snap.exists() ? snap.val() : null;
}

app.get("/", (req, res) => {
  res.send("API online");
});

/* =========================
   DASHBOARD
========================= */
app.get("/admin/dashboard", async (req, res) => {
  try {
    const [licensesSnap, clientsSnap, devicesSnap, latestActivationsSnap] = await Promise.all([
      db.collection("licenses").get(),
      db.collection("clients").get(),
      db.collection("devices").get(),
      db.collection("activations").orderBy("createdAt", "desc").limit(10).get(),
    ]);

    let activeLicenses = 0;
    let expiredLicenses = 0;
    let onlineDevices = 0;
    let monthRevenue = 0;

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    licensesSnap.forEach((doc) => {
      const x = doc.data();
      if (x.status === "active") activeLicenses += 1;
      if (x.status === "expired" || isExpired(x.expiresAt)) expiredLicenses += 1;
    });

    devicesSnap.forEach((doc) => {
      const x = doc.data();
      if (x.sessionState === "online" || x.status === "active") onlineDevices += 1;
    });

    clientsSnap.forEach((doc) => {
      const x = doc.data();
      const createdAt = toDateSafe(x.createdAt);
      if (!createdAt) return;
      if (createdAt.getMonth() === currentMonth && createdAt.getFullYear() === currentYear) {
        monthRevenue += Number(x.planPrice || x.price || 0);
      }
    });

    const latestActivations = latestActivationsSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({
      ok: true,
      totalLicenses: licensesSnap.size,
      activeLicenses,
      expiredLicenses,
      totalClients: clientsSnap.size,
      onlineDevices,
      monthRevenue,
      latestActivations,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "dashboard_error",
      details: error.message,
    });
  }
});

/* =========================
   PLANS
========================= */
app.get("/admin/plans", async (req, res) => {
  try {
    const snap = await db.collection("plans").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_plans",
      details: error.message,
    });
  }
});

app.post("/admin/plans", async (req, res) => {
  try {
    const {
      id,
      name,
      durationHours,
      price,
      allowSecondDeviceSameIp,
      discordLink,
      stockMessage,
      singleSessionOnly,
    } = req.body || {};

    if (!id || !name) {
      return res.status(400).json({
        ok: false,
        error: "missing_plan_fields",
      });
    }

    await db.collection("plans").doc(String(id)).set(
      {
        name: String(name),
        durationHours: Number(durationHours || 0),
        price: Number(price || 0),
        allowSecondDeviceSameIp: Boolean(allowSecondDeviceSameIp),
        discordLink: String(discordLink || ""),
        stockMessage: String(stockMessage || ""),
        singleSessionOnly: singleSessionOnly !== false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, message: "plan_created" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "create_plan_error",
      details: error.message,
    });
  }
});

/* =========================
   LICENSES
========================= */
app.get("/admin/licenses", async (req, res) => {
  try {
    const snap = await db.collection("licenses").orderBy("createdAt", "desc").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_licenses",
      details: error.message,
    });
  }
});

app.post("/admin/licenses", async (req, res) => {
  try {
    const {
      plan,
      quantity,
      status,
      prefix,
      stockMessage,
      discordLink,
      stockMode,
    } = req.body || {};

    if (!plan) {
      return res.status(400).json({
        ok: false,
        error: "missing_plan",
      });
    }

    const planData = await getPlanById(plan);
    if (!planData) {
      return res.status(404).json({
        ok: false,
        error: "plan_not_found",
      });
    }

    const qty = Math.max(1, Number(quantity || 1));
    const createdItems = [];

    for (let i = 0; i < qty; i += 1) {
      const plainKey = generateLicenseKey(prefix || "FXS");
      const keyHash = sha256(plainKey);
      const expiresAtDate =
        Number(planData.durationHours || 0) > 0
          ? new Date(Date.now() + Number(planData.durationHours) * 60 * 60 * 1000)
          : null;

      const ref = db.collection("licenses").doc();

      await ref.set({
        keyHash,
        keyPlainMasked: maskKey(plainKey),
        plan: planData.id,
        planName: planData.name || "",
        price: Number(planData.price || 0),
        durationHours: Number(planData.durationHours || 0),
        allowSecondDeviceSameIp: Boolean(planData.allowSecondDeviceSameIp),
        singleSessionOnly: planData.singleSessionOnly !== false,
        boundHwid: "",
        secondBoundHwid: "",
        boundIp: "",
        clientId: "",
        status: String(status || "active"),
        stockMode: stockMode !== false,
        stockMessage: String(stockMessage || planData.stockMessage || ""),
        discordLink: String(discordLink || planData.discordLink || ""),
        lastValidationAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiresAtDate ? admin.firestore.Timestamp.fromDate(expiresAtDate) : null,
      });

      createdItems.push({
        id: ref.id,
        plainKey,
        masked: maskKey(plainKey),
        plan: planData.id,
      });
    }

    return res.json({
      ok: true,
      message: "licenses_created",
      items: createdItems,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "create_license_error",
      details: error.message,
    });
  }
});

app.post("/admin/licenses/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status) {
      return res.status(400).json({ ok: false, error: "missing_status" });
    }

    await db.collection("licenses").doc(String(id)).update({
      status: String(status),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: "license_status_updated" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "license_status_error",
      details: error.message,
    });
  }
});

app.post("/admin/licenses/:id/reset-hwid", async (req, res) => {
  try {
    const { id } = req.params;

    await db.collection("licenses").doc(String(id)).update({
      boundHwid: "",
      secondBoundHwid: "",
      boundIp: "",
      clientId: "",
      stockMode: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: "license_hwid_reset" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "reset_hwid_error",
      details: error.message,
    });
  }
});

/* =========================
   CLIENTS
========================= */
app.get("/admin/clients", async (req, res) => {
  try {
    const snap = await db.collection("clients").orderBy("createdAt", "desc").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_clients",
      details: error.message,
    });
  }
});

/* =========================
   DEVICES
========================= */
app.get("/admin/devices", async (req, res) => {
  try {
    const snap = await db.collection("devices").orderBy("lastSeenAt", "desc").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_devices",
      details: error.message,
    });
  }
});

/* =========================
   ACTIVATIONS
========================= */
app.get("/admin/activations", async (req, res) => {
  try {
    const snap = await db.collection("activations").orderBy("createdAt", "desc").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_activations",
      details: error.message,
    });
  }
});

/* =========================
   BLACKLIST
========================= */
app.get("/admin/blacklist", async (req, res) => {
  try {
    const snap = await db.collection("blacklist").orderBy("createdAt", "desc").get();
    const items = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "failed_to_load_blacklist",
      details: error.message,
    });
  }
});

app.post("/admin/blacklist", async (req, res) => {
  try {
    const { type, value, reason } = req.body || {};

    if (!type || !value) {
      return res.status(400).json({
        ok: false,
        error: "missing_blacklist_fields",
      });
    }

    await db.collection("blacklist").add({
      type: String(type),
      value: String(value),
      reason: String(reason || ""),
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: "blacklist_created" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "create_blacklist_error",
      details: error.message,
    });
  }
});

app.post("/admin/blacklist/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.collection("blacklist").doc(String(id));
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "blacklist_not_found" });
    }

    await ref.update({
      active: !Boolean(snap.data().active),
    });

    return res.json({ ok: true, message: "blacklist_toggled" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "toggle_blacklist_error",
      details: error.message,
    });
  }
});

/* =========================
   FINANCE
========================= */
app.get("/admin/finance", async (req, res) => {
  try {
    const snap = await db.collection("clients").get();

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    let monthRevenue = 0;
    let monthProfit = 0;
    let monthSales = 0;
    const byPlanMap = {};

    snap.forEach((doc) => {
      const x = doc.data();
      const createdAt = toDateSafe(x.createdAt);
      if (!createdAt) return;
      if (createdAt.getMonth() !== currentMonth || createdAt.getFullYear() !== currentYear) return;

      const price = Number(x.planPrice || x.price || 0);
      const plan = String(x.plan || "unknown");

      monthRevenue += price;
      monthProfit += price;
      monthSales += 1;

      if (!byPlanMap[plan]) {
        byPlanMap[plan] = {
          plan,
          price,
          clientsInMonth: 0,
          revenue: 0,
        };
      }

      byPlanMap[plan].clientsInMonth += 1;
      byPlanMap[plan].revenue += price;
    });

    const averageTicket = monthSales > 0 ? monthRevenue / monthSales : 0;
    const yearProjection = monthRevenue * 12;

    return res.json({
      ok: true,
      monthRevenue,
      monthProfit,
      monthSales,
      averageTicket,
      yearProjection,
      byPlan: Object.values(byPlanMap),
    });
  } catch (error) {
    return res.status(500).json({
      ok
