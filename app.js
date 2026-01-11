// ======================
// FIREBASE CONFIG
// ======================
const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// ======================
// AUTH UI CONTROLS
// ======================
document.addEventListener("DOMContentLoaded", () => {
  const landing = document.getElementById("landing-options");
  const forms = document.getElementById("auth-forms");
  const authForm = document.getElementById("authForm");
  const adminForm = document.getElementById("adminForm");
  const title = document.getElementById("auth-title");

  btn-show-login.onclick = () => {
    landing.classList.add("hidden");
    forms.classList.remove("hidden");
    authForm.classList.remove("hidden");
    adminForm.classList.add("hidden");
    title.textContent = "Student Login";
  };

  btn-show-register.onclick = () => {
    landing.classList.add("hidden");
    forms.classList.remove("hidden");
    authForm.classList.remove("hidden");
    adminForm.classList.add("hidden");
    title.textContent = "Student Registration";
  };

  btn-show-admin.onclick = () => {
    landing.classList.add("hidden");
    forms.classList.remove("hidden");
    adminForm.classList.remove("hidden");
    authForm.classList.add("hidden");
    title.textContent = "Mentor Access";
  };

  btn-back-auth.onclick = () => {
    forms.classList.add("hidden");
    landing.classList.remove("hidden");
    authForm.classList.add("hidden");
    adminForm.classList.add("hidden");
  };
});

// ======================
// LOGIN / REGISTER
// ======================
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = email.value;
  const password = password.value;

  try {
    if (auth-title.textContent.includes("Register")) {
      await auth.createUserWithEmailAndPassword(email, password);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (err) {
    alert(err.message);
  }
});

// ======================
// LOGOUT
// ======================
btn-logout.onclick = () => auth.signOut();

// ======================
// AUTH STATE
// ======================
auth.onAuthStateChanged(user => {
  if (user) {
    authContainer.classList.add("hidden");
    appContent.classList.remove("hidden");
  } else {
    authContainer.classList.remove("hidden");
    appContent.classList.add("hidden");
  }
});

