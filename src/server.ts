import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import cron from "node-cron";
import {
  AlertData,
  FinnhubProfileResponse,
  FinnhubQuoteResponse,
} from "./lib/types";
import { admin, db } from "./lib/firebaseAdmin";
import { sendEmail } from "./lib/emailService";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

export function verifyFirebaseToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.log("Running veryfication");

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "Unauthorized: No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1];

  admin
    .auth()
    .verifyIdToken(token)
    .then((decodedToken) => {
      (req as any).user = decodedToken;
      console.log("Authorized: Access granted");

      next();
    })
    .catch((error) => {
      console.error("Token verification error:", error);
      res.status(401).json({ message: "Unauthorized: Invalid token" });
    });
}

app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Server is running 🚀" });
});

app.get("/stocks", verifyFirebaseToken, async (req: Request, res: Response) => {
  try {
    const symbols: string[] = ["AAPL", "MSFT", "GOOGL", "AMZN"];
    const results: {
      name: string;
      symbol: string;
      currentPrice: number;
      percentChange: string;
      high: number;
      low: number;
    }[] = [];

    for (const symbol of symbols) {
      const response = await axios.get<FinnhubQuoteResponse>(
        `https://finnhub.io/api/v1/quote`,
        {
          params: {
            symbol,
            token: process.env.FINNHUB_API_KEY,
          },
        }
      );

      results.push({
        name: symbol,
        symbol: symbol,
        currentPrice: response.data.c,
        percentChange: (
          ((response.data.c - response.data.pc) / response.data.pc) *
          100
        ).toFixed(2),
        high: response.data.h,
        low: response.data.l,
      });
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch stock data" });
  }
});

app.get("/stock", verifyFirebaseToken, async (req: Request, res: Response) => {
  const { symbol } = req.query;

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ message: "Symbol is required" });
    return;
  }

  try {
    const [quoteRes, profileRes] = await Promise.all([
      axios.get<FinnhubQuoteResponse>(`https://finnhub.io/api/v1/quote`, {
        params: {
          symbol,
          token: process.env.FINNHUB_API_KEY,
        },
      }),
      axios.get<FinnhubProfileResponse>(
        `https://finnhub.io/api/v1/stock/profile2`,
        {
          params: {
            symbol,
            token: process.env.FINNHUB_API_KEY,
          },
        }
      ),
    ]);

    res.json({
      symbol,
      name: profileRes.data.name, //
      currentPrice: quoteRes.data.c,
      percentChange: (
        ((quoteRes.data.c - quoteRes.data.pc) / quoteRes.data.pc) *
        100
      ).toFixed(2),
      high: quoteRes.data.h,
      low: quoteRes.data.l,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch stock data" });
  }
});

app.post(
  "/postalert",
  verifyFirebaseToken,
  async (req: Request, res: Response) => {
    const { symbol, targetPrice, alertName, direction } = req.body;
    const uid = (req as any).user.uid;

    if (!symbol || !targetPrice || !alertName || !direction) {
      console.error("Adding alert error: Data is missing:", req.body);
      res.status(400).json({ message: "Missing fields" });
      return;
    }

    if (!["above", "below"].includes(direction)) {
      res.status(400).json({ message: "Invalid direction" });
      return;
    }

    try {
      const docRef = await db.collection("alerts").add({
        userId: uid,
        symbol,
        targetPrice,
        alertName,
        direction,
        createdAt: new Date(),
        triggered: false,
      });

      res.status(201).json({ message: "Alert saved", id: docRef.id });
    } catch (error) {
      console.error("Error saving alert:", error);
      res.status(500).json({ message: "Failed to save alert" });
    }
  }
);

app.get("/alerts", verifyFirebaseToken, async (req: Request, res: Response) => {
  const uid = (req as any).user.uid;

  try {
    const q = admin.firestore().collection("alerts").where("userId", "==", uid);
    const snapshot = await q.get();

    const alerts = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json(alerts);
  } catch (error) {
    console.error("Error fetching alerts:", error);
    res.status(500).json({ message: "Failed to fetch alerts" });
  }
});

app.delete(
  "/alerts/:id",
  verifyFirebaseToken,
  async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const { id } = req.params;

    try {
      const alertRef = admin.firestore().collection("alerts").doc(id);
      const docSnap = await alertRef.get();

      if (!docSnap.exists) {
        res.status(404).json({ message: "Alert not found" });
        return;
      }

      if (docSnap.data()?.userId !== uid) {
        res
          .status(403)
          .json({ message: "You do not have permission to delete this alert" });
        return;
      }

      await alertRef.delete();
      res.status(200).json({ message: "Alert deleted" });
    } catch (error) {
      console.error("Error deleting alert:", error);
      res.status(500).json({ message: "Failed to delete alert" });
    }
  }
);

cron.schedule("*/5 * * * *", async () => {
  console.log("🔍 Running alert checker...");

  const alertsSnapshot = await admin
    .firestore()
    .collection("alerts")
    .where("triggered", "==", false)
    .get();

  if (alertsSnapshot.empty) {
    console.log("No pending alerts.");
    return;
  }

  const alerts = alertsSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<AlertData, "id">),
  })) as AlertData[];

  for (const alert of alerts) {
    try {
      const { id, symbol, userId, targetPrice, direction } = alert;

      // 1) fetch current price
      const { data } = await axios.get<{
        c: number; // current price
      }>("https://finnhub.io/api/v1/quote", {
        params: {
          symbol,
          token: process.env.FINNHUB_API_KEY,
        },
      });
      const currentPrice = data.c;

      // 2) determine if it's time to fire
      let shouldTrigger = false;
      if (direction === "above" && currentPrice >= targetPrice) {
        shouldTrigger = true;
      } else if (direction === "below" && currentPrice <= targetPrice) {
        shouldTrigger = true;
      }

      if (!shouldTrigger) {
        console.log(
          `⏳ ${symbol}: ${currentPrice} has not ${
            direction === "above" ? "risen to" : "fallen to"
          } ${targetPrice} yet.`
        );
        continue;
      }

      console.log(`🚨 Alert triggered for ${symbol} at ${currentPrice}`);

      // 3) lookup user & send email
      const userRecord = await admin.auth().getUser(userId);
      const email = userRecord.email;
      if (email) {
        await sendEmail(
          email,
          `Stock Alert: ${symbol}`,
          `The price of ${symbol} has ${
            direction === "above" ? "risen to" : "fallen to"
          } your target of $${targetPrice}.\n\nCurrent Price: $${currentPrice}`
        );
        console.log(`📩 Email sent to ${email}`);
      }

      // 4) mark as triggered
      await admin.firestore().collection("alerts").doc(id).update({
        triggered: true,
        triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("Error checking alert:", err);
    }
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🔥 Server running on http://localhost:${PORT}`);
});
