import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
const cfg={apiKey:'AIzaSyDD-jSNG_HfhW4aTXtdf0kpdclaDVbgrNA',authDomain:'book-my-car-a97cf.firebaseapp.com',projectId:'book-my-car-a97cf',storageBucket:'book-my-car-a97cf.firebasestorage.app',messagingSenderId:'546652899903',appId:'1:546652899903:web:c280a58db101e01d1d468a'};
const app=initializeApp(cfg); const messaging=getMessaging(app);
export async function enableAdminNotifications(){
  if(!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('इस browser में notifications supported नहीं हैं।');
  const permission=await Notification.requestPermission();
  if(permission!=='granted') throw new Error('Notification permission denied.');
  const registration=await navigator.serviceWorker.register('./firebase-messaging-sw.js');
  const token=await getToken(messaging,{serviceWorkerRegistration:registration,vapidKey:'REPLACE_WITH_FIREBASE_WEB_PUSH_CERTIFICATE_KEY_PAIR_PUBLIC_KEY'});
  if(!token) throw new Error('FCM token नहीं मिला।');
  const {getFirestore,doc,setDoc,serverTimestamp}=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const db=getFirestore(app); await setDoc(doc(db,'adminTokens',btoa(token).replace(/[^a-zA-Z0-9]/g,'').slice(0,120)),{token,createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
  return true;
}
onMessage(messaging,p=>{ if(p?.notification) new Notification(p.notification.title,{body:p.notification.body}); });
