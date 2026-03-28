const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// --- INITIALIZATION ---
// Ensure FIREBASE_SERVICE_ACCOUNT_JSON and CASHFREE_APP_ID/SECRET are in env
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}

const db = admin.firestore();
const app = express();
app.use(express.json());

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET = process.env.CASHFREE_SECRET;
const CASHFREE_ENV = "PROD"; // or "TEST"

// --- MIDDLEWARE: AUTHENTICATION ---
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.uid = decodedToken.uid;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// --- AUTH ENDPOINTS ---
app.post('/auth/signup', authenticate, async (req, res) => {
  const { username, email, referralCode } = req.body;
  const userRef = db.collection('users').doc(req.uid);

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (userDoc.exists) return;

      const newReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      t.set(userRef, {
        username,
        email,
        wallet: 0,
        totalXP: 0,
        joinedMatches: [],
        referralCode: newReferralCode,
        referredBy: referralCode || null,
        matchesPlayed: 0,
        totalKills: 0,
        dailyStreak: 0,
        isVIP: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WALLET: CREATE ORDER ---
app.post('/wallet/createOrder', authenticate, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const orderId = `order_${uuidv4().replace(/-/g, '')}`;
  
  try {
    // Cashfree Create Order API (v3)
    const response = await fetch(`https://${CASHFREE_ENV === 'PROD' ? 'api' : 'sandbox'}.cashfree.com/pg/orders`, {
      method: 'POST',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: req.uid,
          customer_phone: "9999999999" // Dummy or fetch from user
        }
      })
    });

    const data = await response.json();
    if (!data.payment_session_id) throw new Error('Cashfree order creation failed');

    await db.collection('transactions').doc(orderId).set({
      userId: req.uid,
      type: 'DEPOSIT',
      amount: parseFloat(amount),
      status: 'PENDING',
      orderId: orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ payment_session_id: data.payment_session_id, order_id: orderId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WALLET: WEBHOOK (CASHFREE) ---
app.post('/webhook/cashfree', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = JSON.stringify(req.body);

  // Verify Webhook Signature
  const data = timestamp + rawBody;
  const expectedSignature = crypto.createHmac('sha256', CASHFREE_SECRET).update(data).digest('base64');

  if (signature !== expectedSignature) return res.status(401).send('Invalid Signature');

  const { order, payment } = req.body.data;
  const orderId = order.order_id;
  const amount = order.order_amount;
  const status = payment.payment_status;

  const transRef = db.collection('transactions').doc(orderId);

  try {
    await db.runTransaction(async (t) => {
      const transDoc = await t.get(transRef);
      if (!transDoc.exists || transDoc.data().status !== 'PENDING') return;

      if (status === 'SUCCESS') {
        const userRef = db.collection('users').doc(transDoc.data().userId);
        t.update(userRef, { wallet: admin.firestore.FieldValue.increment(amount) });
        t.update(transRef, { status: 'SUCCESS' });
      } else if (['FAILED', 'CANCELLED'].includes(status)) {
        t.update(transRef, { status: 'FAILED' });
      }
    });
    res.status(200).send('OK');
  } catch (e) {
    res.status(500).send('Internal Error');
  }
});

// --- MATCH: JOIN ---
app.post('/match/join', authenticate, async (req, res) => {
  const { matchId, gameUids } = req.body;
  if (!Array.isArray(gameUids) || ![1, 2, 4].includes(gameUids.length)) {
    return res.status(400).json({ error: 'Invalid gameUids' });
  }

  const matchRef = db.collection('matches').doc(matchId);
  const userRef = db.collection('users').doc(req.uid);
  const teamRef = matchRef.collection('teams').doc(req.uid);

  try {
    await db.runTransaction(async (t) => {
      const match = (await t.get(matchRef)).data();
      const user = (await t.get(userRef)).data();

      if (!match || match.status !== 'upcoming') throw new Error('Match not available');
      if (user.wallet < match.entryFee) throw new Error('Insufficient balance');
      if (match.joinedCount + gameUids.length > match.maxPlayers) throw new Error('Match full');
      
      // Check for duplicate gameUids in this match
      const existingTeams = await t.get(matchRef.collection('teams'));
      const allGameUids = [];
      existingTeams.forEach(doc => allGameUids.push(...doc.data().gameUids));
      if (gameUids.some(id => allGameUids.includes(id))) throw new Error('Game UID already registered');

      t.update(userRef, { 
        wallet: admin.firestore.FieldValue.increment(-match.entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      t.set(teamRef, {
        ownerUid: req.uid,
        ownerUsername: user.username,
        gameUids: gameUids
      });

      t.update(matchRef, { joinedCount: admin.firestore.FieldValue.increment(gameUids.length) });
      
      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'MATCH_JOIN',
        amount: match.entryFee,
        status: 'SUCCESS',
        matchId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- REWARDS: DAILY ---
app.post('/rewards/daily', authenticate, async (req, res) => {
  const userRef = db.collection('users').doc(req.uid);
  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const user = userDoc.data();
      const lastClaim = user.lastDailyClaim?.toDate() || new Date(0);
      const now = new Date();

      if (now - lastClaim < 24 * 60 * 60 * 1000) throw new Error('Already claimed');

      const reward = 10; // Logic for rewards
      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(reward),
        dailyStreak: admin.firestore.FieldValue.increment(1),
        lastDailyClaim: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'DAILY_REWARD',
        amount: reward,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- WALLET: WITHDRAW ---
app.post('/wallet/withdraw', authenticate, async (req, res) => {
  const { amount, upiId } = req.body;
  if (amount < 50) return res.status(400).json({ error: 'Min withdrawal 50' });

  const userRef = db.collection('users').doc(req.uid);
  try {
    await db.runTransaction(async (t) => {
      const user = (await t.get(userRef)).data();
      if (user.wallet < amount) throw new Error('Insufficient balance');

      t.update(userRef, { wallet: admin.firestore.FieldValue.increment(-amount) });
      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'WITHDRAWAL',
        amount,
        upiId,
        status: 'PENDING',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- ADMIN: DISTRIBUTE PRIZE ---
app.post('/admin/match/distribute', authenticate, async (req, res) => {
  const { matchId, gameUid, rank, kills } = req.body;
  // Note: Add logic here to verify if req.uid is an admin
  
  const matchRef = db.collection('matches').doc(matchId);
  
  try {
    const teamsSnap = await matchRef.collection('teams').where('gameUids', 'array-contains', gameUid).get();
    if (teamsSnap.empty) return res.status(404).json({ error: 'Team not found' });
    
    const teamDoc = teamsSnap.docs[0];
    const ownerUid = teamDoc.data().ownerUid;
    const userRef = db.collection('users').doc(ownerUid);
    const prizeId = `prize_${matchId}_${ownerUid}`;

    await db.runTransaction(async (t) => {
      const match = (await t.get(matchRef)).data();
      const prizeDoc = await t.get(db.collection('transactions').doc(prizeId));
      
      if (prizeDoc.exists) throw new Error('Prize already distributed for this user');

      const rankPrize = match.rankPrizes[rank] || 0;
      const killPrize = kills * (match.perKillRate || 0);
      const totalPrize = rankPrize + killPrize;
      const xpGained = (kills * 10) + (rank === 1 ? 100 : 20);

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(totalPrize),
        totalXP: admin.firestore.FieldValue.increment(xpGained),
        matchesPlayed: admin.firestore.FieldValue.increment(1),
        totalKills: admin.firestore.FieldValue.increment(kills)
      });

      t.set(db.collection('transactions').doc(prizeId), {
        userId: ownerUid,
        type: 'PRIZE',
        amount: totalPrize,
        status: 'SUCCESS',
        matchId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
        
