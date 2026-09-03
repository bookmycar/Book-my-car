importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDD-jSNG_HfhW4aTXtdf0kpdclaDVbgrNA',
  authDomain: 'book-my-car-a97cf.firebaseapp.com',
  projectId: 'book-my-car-a97cf',
  storageBucket: 'book-my-car-a97cf.firebasestorage.app',
  messagingSenderId: '546652899903',
  appId: '1:546652899903:web:c280a58db101e01d1d468a'
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || 'Book My Car';
  const options = {
    body: payload.notification?.body || 'नई activity हुई है।',
    icon: '/Book-my-car/icon-192.png',
    data: { url: payload.data?.url || '/Book-my-car/Admin.html' }
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/Book-my-car/Admin.html';
  event.waitUntil(clients.openWindow(url));
});
