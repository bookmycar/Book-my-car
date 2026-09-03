const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const RAZORPAY_KEY_ID = defineSecret('RAZORPAY_KEY_ID');
const RAZORPAY_KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET');

const cors = (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://bookmycar.github.io');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  return false;
};

exports.createRazorpayOrder = onRequest({ secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET], region: 'asia-south1' }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  try {
    const { bookingId } = req.body || {};
    if (!bookingId || typeof bookingId !== 'string') return res.status(400).json({ error: 'bookingId required' });
    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Booking not found' });
    const b = snap.data();
    if (b.status !== 'Pending') return res.status(400).json({ error: 'Booking is not pending' });
    if (b.paymentStatus === 'Verified') return res.status(400).json({ error: 'Payment already verified' });
    const amount = Math.round(Number(b.totalFare || 0) * 100);
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000000) return res.status(400).json({ error: 'Invalid payment amount' });

    const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID.value(), key_secret: RAZORPAY_KEY_SECRET.value() });
    const order = await razorpay.orders.create({ amount, currency: 'INR', receipt: bookingId.slice(0, 40), notes: { bookingId } });
    await ref.update({ razorpayOrderId: order.id, paymentStatus: 'Order Created', paymentGateway: 'Razorpay', paymentUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ keyId: RAZORPAY_KEY_ID.value(), orderId: order.id, amount: order.amount, currency: order.currency, bookingId });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Unable to create payment order' }); }
});

exports.verifyRazorpayPayment = onRequest({ secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET], region: 'asia-south1' }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  try {
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!bookingId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Payment verification data incomplete' });
    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Booking not found' });
    const b = snap.data();
    if (b.razorpayOrderId !== razorpay_order_id) return res.status(400).json({ error: 'Order mismatch' });
    const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET.value()).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid payment signature' });
    await ref.update({ paymentStatus: 'Verified', razorpayPaymentId: razorpay_payment_id, razorpaySignatureVerified: true, paymentVerifiedAt: admin.firestore.FieldValue.serverTimestamp(), paymentUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ verified: true, bookingId });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Payment verification failed' }); }
});
