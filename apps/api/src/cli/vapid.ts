import webpush from "web-push";

// Prints a fresh VAPID key pair for web push, in .env format. Run once per server and keep the private key secret.
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
