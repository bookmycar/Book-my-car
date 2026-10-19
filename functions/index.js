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
const GOOGLE_MAPS_API_KEY = defineSecret('GOOGLE_MAPS_API_KEY');
const cors=(req,res)=>{const o=req.get('Origin');if(o==='https://bookmycar.github.io')res.set('Access-Control-Allow-Origin',o);res.set('Vary','Origin');res.set('Access-Control-Allow-Methods','POST, OPTIONS');res.set('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS'){res.status(204).send('');return true}return false};
async function notifyAdmins(title,body,data={}){const s=await db.collection('adminTokens').get(),tokens=s.docs.map(d=>d.data().token).filter(Boolean);if(!tokens.length)return;const r=await admin.messaging().sendEachForMulticast({tokens,notification:{title,body},data:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v)])),webpush:{fcmOptions:{link:'https://bookmycar.github.io/Book-my-car/Admin.html'}}});const bad=[];r.responses.forEach((x,i)=>{if(!x.success&&['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(x.error?.code))bad.push(tokens[i])});if(bad.length){const b=db.batch();s.docs.forEach(d=>{if(bad.includes(d.data().token))b.delete(d.ref)});await b.commit()}}
exports.notifyNewBooking=onDocumentCreated({document:'bookings/{bookingId}',region:'asia-south1'},async e=>{const b=e.data?.data();if(b)await notifyAdmins('🚗 New Booking',`${b.customerName||'Customer'} • ${b.pickup||''} → ${b.destination||''} • ₹${Math.round(Number(b.totalFare||0)).toLocaleString('en-IN')}`,{type:'booking',bookingId:e.params.bookingId})});
exports.notifyNewCar=onDocumentCreated({document:'cars/{carId}',region:'asia-south1'},async e=>{const c=e.data?.data();if(c)await notifyAdmins('🚘 New Car Added',`${c.carName||'New car'} • Owner: ${c.ownerName||'Owner'}`,{type:'car',carId:e.params.carId})});

// Google-backed route calculation. The API key stays server-side in Secret Manager.
exports.calculateRoute=onRequest({region:'asia-south1',secrets:[GOOGLE_MAPS_API_KEY]},async(req,res)=>{if(cors(req,res))return;if(req.method!=='POST')return res.status(405).json({error:'POST required'});try{const {origin,destination}=req.body||{};if(typeof origin!=='string'||typeof destination!=='string'||origin.trim().length<2||destination.trim().length<2||origin.length>200||destination.length>200)return res.status(400).json({error:'Valid pickup and destination are required'});const key=GOOGLE_MAPS_API_KEY.value();const g=async address=>{const u='https://maps.googleapis.com/maps/api/geocode/json?address='+encodeURIComponent(address+', India')+'&components=country:IN&region=in&language=en&key='+encodeURIComponent(key);const r=await fetch(u);if(!r.ok)throw Error('Google location service unavailable');const j=await r.json();if(j.status!=='OK'||!j.results?.length)throw Error('Google location नहीं मिली: '+address);const x=j.results[0];return{lat:x.geometry.location.lat,lng:x.geometry.location.lng,address:x.formatted_address}};const A=await g(origin),B=await g(destination);if(A.lat===B.lat&&A.lng===B.lng)throw Error('Pickup और Destination एक ही जगह है।');const rr=await fetch('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters'},body:JSON.stringify({origin:{location:{latLng:{latitude:A.lat,longitude:A.lng}}},destination:{location:{latLng:{latitude:B.lat,longitude:B.lng}}},travelMode:'DRIVE',routingPreference:'TRAFFIC_UNAWARE',computeAlternativeRoutes:false,routeModifiers:{avoidTolls:false,avoidHighways:false,avoidFerries:false},languageCode:'en-IN',units:'METRIC'})});if(!rr.ok){const t=await rr.text();console.error(t);throw Error('Google road route service unavailable')}const j=await rr.json();const r=j.routes?.[0];if(!r||typeof r.distanceMeters!=='number')throw Error('Google driving route नहीं मिली');return res.json({oneWayKm:Number((r.distanceMeters/1000).toFixed(2)),duration:r.duration||'',origin:A,destination:B,polyline:r.polyline?.encodedPolyline||''})}catch(e){console.error(e);return res.status(500).json({error:e.message||'Route calculation failed'})}});

exports.getBooking=onRequest({region:'asia-south1'},async(req,res)=>{if(cors(req,res))return;if(req.method!=='POST')return res.status(405).json({error:'POST required'});try{const{bookingId,mobile}=req.body||{};if(typeof bookingId!=='string'||!bookingId.trim()||!/^\d{10}$/.test(String(mobile||'')))return res.status(400).json({error:'Booking ID and 10 digit mobile are required'});const s=await db.collection('bookings').doc(bookingId.trim()).get();if(!s.exists)return res.status(404).json({error:'Booking not found'});const b=s.data();if(String(b.mobile)!==String(mobile))return res.status(403).json({error:'Booking ID and mobile do not match'});return res.json({bookingId:s.id,booking:{customerName:b.customerName||'',mobile:'******'+String(b.mobile).slice(-4),pickup:b.pickup||'',destination:b.destination||'',carName:b.carName||'',date:b.date||'',pickupTime:b.pickupTime||'',tripType:b.tripType||'',distanceKm:Number(b.distanceKm||0),paymentMethod:b.paymentMethod||'',paymentStatus:b.paymentStatus||'Pending',status:b.status||'Pending',totalFare:Number(b.totalFare||0)}})}catch(e){console.error(e);return res.status(500).json({error:'Unable to load booking'})}});
exports.createRazorpayOrder=onRequest({secrets:[RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET],region:'asia-south1'},async(req,res)=>{if(cors(req,res))return;if(req.method!=='POST')return res.status(405).json({error:'POST required'});try{const{bookingId}=req.body||{};if(!bookingId||typeof bookingId!=='string')return res.status(400).json({error:'bookingId required'});const ref=db.collection('bookings').doc(bookingId),s=await ref.get();if(!s.exists)return res.status(404).json({error:'Booking not found'});const b=s.data();if(b.status!=='Pending')return res.status(400).json({error:'Booking is not pending'});if(b.paymentStatus==='Verified')return res.status(400).json({error:'Payment already verified'});const amount=Math.round(Number(b.totalFare||0)*100);if(!Number.isInteger(amount)||amount<100||amount>100000000)return res.status(400).json({error:'Invalid payment amount'});const rz=new Razorpay({key_id:RAZORPAY_KEY_ID.value(),key_secret:RAZORPAY_KEY_SECRET.value()}),o=await rz.orders.create({amount,currency:'INR',receipt:bookingId.slice(0,40),notes:{bookingId}});await ref.update({razorpayOrderId:o.id,paymentStatus:'Order Created',paymentGateway:'Razorpay',paymentUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});return res.json({keyId:RAZORPAY_KEY_ID.value(),orderId:o.id,amount:o.amount,currency:o.currency,bookingId})}catch(e){console.error(e);return res.status(500).json({error:'Unable to create payment order'})}});
exports.verifyRazorpayPayment=onRequest({secrets:[RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET],region:'asia-south1'},async(req,res)=>{if(cors(req,res))return;if(req.method!=='POST')return res.status(405).json({error:'POST required'});try{const{bookingId,razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};if(!bookingId||!razorpay_order_id||!razorpay_payment_id||!razorpay_signature)return res.status(400).json({error:'Payment verification data incomplete'});const ref=db.collection('bookings').doc(bookingId),s=await ref.get();if(!s.exists)return res.status(404).json({error:'Booking not found'});if(s.data().razorpayOrderId!==razorpay_order_id)return res.status(400).json({error:'Order mismatch'});const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET.value()).update(razorpay_order_id+'|'+razorpay_payment_id).digest('hex');if(expected!==razorpay_signature)return res.status(400).json({error:'Invalid payment signature'});await ref.update({paymentStatus:'Verified',razorpayPaymentId:razorpay_payment_id,razorpaySignatureVerified:true,paymentVerifiedAt:admin.firestore.FieldValue.serverTimestamp(),paymentUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});return res.json({verified:true,bookingId})}catch(e){console.error(e);return res.status(500).json({error:'Payment verification failed'})}});

// Secure trip OTP: OTP is stored only in a server-only collection.
// Firestore client rules must not grant access to bookingSecrets.
exports.onBookingStatusChanged = require('firebase-functions/v2/firestore').onDocumentUpdated({document:'bookings/{bookingId}',region:'asia-south1'}, async e => {
  const before=e.data.before.data(), after=e.data.after.data(), bookingId=e.params.bookingId;
  if(!before || !after || before.status===after.status) return;
  if(after.status==='Confirmed' && before.status!=='Confirmed') {
    const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
    const now=Date.now();
    await db.runTransaction(async tx=>{
      const ref=db.collection('bookingSecrets').doc(bookingId);
      const existing=await tx.get(ref);
      if(existing.exists && existing.data().used!==true && Number(existing.data().expiresAt||0)>now) return;
      tx.set(ref,{otp:code,createdAt:admin.firestore.FieldValue.serverTimestamp(),expiresAt:now+10*60*1000,attempts:0,used:false});
      tx.update(e.data.after.ref,{otpStatus:'Ready',otpIssuedAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    await notifyAdmins('🔐 Trip OTP जारी हुआ',`Booking ${bookingId} confirmed. OTP ग्राहक को सुरक्षित endpoint से मिलेगा; Admin notification में OTP नहीं दिखाया गया.`,{type:'otp_issued',bookingId});
  }
  const labels={Confirmed:'Booking Confirmed',Cancelled:'Booking Cancelled','Trip Started':'Trip Started','Trip Completed':'Trip Completed'};
  if(labels[after.status]) await notifyAdmins('🚗 '+labels[after.status],`Booking ${bookingId} • ${after.pickup||''} → ${after.destination||''}`,{type:'booking_status',bookingId,status:after.status});
});

// Customer obtains the OTP only with booking ID + matching mobile, after confirmation.
// Return the trip OTP only after Firebase Phone Auth proves control of the
// exact phone number stored on this booking. Do not rely on booking ID alone.
exports.getTripOtp = onRequest({region:'asia-south1'},async(req,res)=>{
  if(cors(req,res)) return;
  if(req.method!=='POST') return res.status(405).json({error:'POST required'});
  try{
    const authHeader=String(req.get('Authorization')||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Verify the booking mobile by SMS first'});
    const decoded=await admin.auth().verifyIdToken(authHeader.slice(7));
    const {bookingId}=req.body||{};
    if(typeof bookingId!=='string'||bookingId.trim().length<1||bookingId.length>100) return res.status(400).json({error:'Valid booking ID required'});
    const ref=db.collection('bookings').doc(bookingId.trim()),snap=await ref.get();
    if(!snap.exists) return res.status(404).json({error:'Booking not found'});
    const b=snap.data();
    const expectedPhone='+91'+String(b.mobile||'');
    if(!decoded.phone_number||decoded.phone_number!==expectedPhone) return res.status(403).json({error:'Verified phone does not match this booking'});
    if(b.status!=='Confirmed') return res.status(409).json({error:'OTP is available only after booking confirmation'});
    const sec=await db.collection('bookingSecrets').doc(snap.id).get();
    if(!sec.exists||sec.data().used||Date.now()>Number(sec.data().expiresAt||0)||!sec.data().otp) return res.status(410).json({error:'OTP expired or unavailable. Contact Admin to reissue it.'});
    return res.json({bookingId:snap.id,otp:sec.data().otp,expiresAt:sec.data().expiresAt});
  }catch(err){console.error(err);return res.status(401).json({error:'Phone verification or OTP retrieval failed'});}
});

// Only the Firebase-authenticated UID assigned to a booking may verify its OTP.
exports.verifyTripOtp = onRequest({region:'asia-south1'},async(req,res)=>{
  if(cors(req,res)) return;
  if(req.method!=='POST') return res.status(405).json({error:'POST required'});
  try{
    const authHeader=String(req.get('Authorization')||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Driver sign-in required'});
    const decoded=await admin.auth().verifyIdToken(authHeader.slice(7));
    const {bookingId,otp}=req.body||{};
    if(typeof bookingId!=='string'||typeof otp!=='string'||!/^\d{6}$/.test(otp)) return res.status(400).json({error:'Booking ID and 6 digit OTP are required'});
    const ref=db.collection('bookings').doc(bookingId.trim()), secretRef=db.collection('bookingSecrets').doc(bookingId.trim());
    const result=await db.runTransaction(async tx=>{
      const [bSnap,sSnap]=await Promise.all([tx.get(ref),tx.get(secretRef)]);
      if(!bSnap.exists||!sSnap.exists) return {status:404,error:'Booking or OTP not found'};
      const b=bSnap.data(),s=sSnap.data(),now=Date.now();
      if(!b.driverUid || b.driverUid!==decoded.uid) return {status:403,error:'This driver is not assigned to this booking'};
      if(b.status!=='Confirmed') return {status:409,error:'Booking is not confirmed'};
      if(s.used) return {status:409,error:'OTP has already been used'};
      if(now>Number(s.expiresAt||0)) return {status:410,error:'OTP expired'};
      if(Number(s.attempts||0)>=5) return {status:429,error:'Too many attempts. Contact Admin.'};
      if(s.otp!==otp){tx.update(secretRef,{attempts:admin.firestore.FieldValue.increment(1)});return {status:400,error:'Incorrect OTP'};}
      tx.update(secretRef,{used:true,usedAt:admin.firestore.FieldValue.serverTimestamp(),otp:admin.firestore.FieldValue.delete()});
      tx.update(ref,{status:'Trip Started',tripStartedAt:admin.firestore.FieldValue.serverTimestamp(),otpStatus:'Verified'});
      return {status:200,ok:true};
    });
    if(result.status!==200) return res.status(result.status).json({error:result.error});
    await notifyAdmins('🟢 Trip Started',`Booking ${bookingId} OTP verified by assigned driver.`,{type:'trip_started',bookingId});
    return res.json({verified:true,status:'Trip Started'});
  }catch(err){console.error(err);return res.status(401).json({error:'Driver authentication or OTP verification failed'});}
});
