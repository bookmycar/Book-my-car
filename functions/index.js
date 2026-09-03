const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const RAZORPAY_KEY_ID = defineSecret('RAZORPAY_KEY_ID');
const RAZORPAY_KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET');

const cors = (req, res) => {
  const origin = req.get('Origin');
  if (origin === 'https://bookmycar.github.io') res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  return false;
};

async function notifyAdmins(title, body, data = {}) {
  const snap = await db.collection('adminTokens').get();
  const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) return;
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    webpush: { fcmOptions: { link: 'https://bookmycar.github.io/Book-my-car/Admin.html' } }
  });
  const bad = [];
  response.responses.forEach((r, i) => {
    if (!r.success && ['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(r.error?.code)) bad.push(tokens[i]);
  });
  if (bad.length) {
    const batch = db.batch();
    snap.docs.forEach(d => { if (bad.includes(d.data().token)) batch.delete(d.ref); });
    await batch.commit();
  }
}

exports.notifyNewBooking = onDocumentCreated({ document: 'bookings/{bookingId}', region: 'asia-south1' }, async event => {
  const b = event.data?.data();
  if (!b) return;
  await notifyAdmins('🚗 New Booking', `${b.customerName || 'Customer'} • ${b.pickup || ''} → ${b.destination || ''} • ₹${Math.round(Number(b.totalFare || 0)).toLocaleString('en-IN')}`, { type: 'booking', bookingId: event.params.bookingId });
});

exports.notifyNewCar = onDocumentCreated({ document: 'cars/{carId}', region: 'asia-south1' }, async event => {
  const c = event.data?.data();
  if (!c) return;
  await notifyAdmins('🚘 New Car Added', `${c.carName || 'New car'} • Owner: ${c.ownerName || 'Owner'}`, { type: 'car', carId: event.params.carId });
});

exports.getBooking = onRequest({ region: 'asia-south1' }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  try {
    const { bookingId, mobile } = req.body || {};
    if (typeof bookingId !== 'string' || !bookingId.trim() || !/^\d{10}$/.test(String(mobile || ''))) return res.status(400).json({ error: 'Booking ID and 10 digit mobile are required' });
    const snap = await db.collection('bookings').doc(bookingId.trim()).get();
    if (!snap.exists) return res.status(404).json({ error: 'Booking not found' });
    const b = snap.data();
    if (String(b.mobile) !== String(mobile)) return res.status(403).json({ error: 'Booking ID and mobile do not match' });
    return res.json({ bookingId: snap.id, booking: {
      customerName: b.customerName || '', mobile: '******' + String(b.mobile).slice(-4),
      pickup: b.pickup || '', destination: b.destination || '', carName: b.carName || '',
      date: b.date || '', pickupTime: b.pickupTime || '', tripType: b.tripType || '',
      distanceKm: Number(b.distanceKm || 0), paymentMethod: b.paymentMethod || '',
      paymentStatus: b.paymentStatus || 'Pending', status: b.status || 'Pending',
      totalFare: Number(b.totalFare || 0)
    }});
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Unable to load booking' }); }
});

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