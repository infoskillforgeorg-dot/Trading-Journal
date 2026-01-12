const firebaseConfig = {
    apiKey: "AIzaSyAVd8ZiE59c5gNFyX9K8K-HGm6natzSLsw",
    authDomain: "skillforge-trading-journal.firebaseapp.com",
    projectId: "skillforge-trading-journal",
    storageBucket: "skillforge-trading-journal.firebasestorage.app",
    messagingSenderId: "456859128026",
    appId: "1:456859128026:web:bdab9707425d19807a55e3",
    measurementId: "G-32Z5D74LT9"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

let selectedStudentId = null;

document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    loadStudents();
});

// --- Notifications ---
function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container') || createNotificationContainer();
    const notif = document.createElement('div');
    notif.className = `p-4 rounded-xl shadow-2xl mb-3 text-sm font-bold text-white transform transition-all translate-x-full ${
        type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-blue-600'
    }`;
    notif.innerHTML = `<div class="flex items-center gap-3"><i data-lucide="${type === 'error' ? 'alert-circle' : 'check-circle'}" class="w-5 h-5"></i><span>${message}</span></div>`;
    
    container.appendChild(notif);
    lucide.createIcons();

    requestAnimationFrame(() => notif.classList.remove('translate-x-full'));

    setTimeout(() => {
        notif.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => notif.remove(), 300);
    }, 4000);
}

function createNotificationContainer() {
    const div = document.createElement('div');
    div.id = 'notification-container';
    div.className = 'fixed top-4 right-4 z-[300] flex flex-col items-end w-full max-w-sm pointer-events-none';
    document.body.appendChild(div);
    return div;
}

async function loadStudents() {
    const list = document.getElementById('studentList');
    try {
        const snap = await db.collection('users').get();
        if (snap.empty) {
            list.innerHTML = '<p class="text-center text-slate-500 text-xs mt-4">No students found.</p>';
            return;
        }

        list.innerHTML = snap.docs.map(doc => {
            const data = doc.data();
            const email = data.email || 'Unknown User';
            // Generate a consistent color based on email char code
            const colors = ['bg-blue-600', 'bg-purple-600', 'bg-green-600', 'bg-yellow-600', 'bg-pink-600'];
            const colorIndex = email.charCodeAt(0) % colors.length;
            const bgClass = colors[colorIndex];

            return `
                <div onclick="selectStudent('${doc.id}', '${email}')" 
                    class="p-3 rounded-lg hover:bg-slate-800 cursor-pointer transition-colors border border-transparent hover:border-slate-700 group flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full ${bgClass} flex items-center justify-center text-xs font-bold text-white shadow-lg shrink-0">
                        ${email.substring(0, 2).toUpperCase()}
                    </div>
                    <div class="overflow-hidden">
                        <p class="text-xs font-bold text-slate-300 truncate group-hover:text-white transition-colors">${email}</p>
                        <p class="text-[10px] text-slate-500 truncate font-mono">ID: ${doc.id.slice(0,6)}</p>
                    </div>
                    <i data-lucide="chevron-right" class="w-4 h-4 text-slate-600 group-hover:text-slate-400 ml-auto opacity-0 group-hover:opacity-100 transition-all"></i>
                </div>
            `;
        }).join('');
        lucide.createIcons();

    } catch (error) {
        console.error("Error loading students:", error);
        list.innerHTML = `<p class="text-center text-red-500 text-xs mt-4">Error: ${error.message}</p>`;
        showNotification('Failed to load students', 'error');
    }
}

async function selectStudent(uid, email) {
    selectedStudentId = uid;
    document.getElementById('studentHeader').classList.remove('hidden');
    document.getElementById('feedbackSection').classList.remove('hidden');
    document.getElementById('studentEmail').innerText = email;
    document.getElementById('studentId').innerText = uid;
    
    loadStudentTrades(uid);
    loadStudentComments(uid);
}

function loadStudentTrades(uid) {
    db.collection('users').doc(uid).collection('trades')
        .orderBy('openTime', 'desc')
        .onSnapshot(snap => {
            const trades = snap.docs.map(d => d.data());
            const totalPnl = trades.reduce((acc, t) => acc + (t.status === 'closed' ? (t.pnl || 0) : 0), 0);
            
            document.getElementById('adminTotalPnl').innerText = `$${totalPnl.toFixed(2)}`;
            document.getElementById('adminTotalPnl').className = `text-2xl font-black font-mono ${totalPnl >= 0 ? 'profit-text' : 'loss-text'}`;

            const tbody = document.getElementById('adminTradeTable');
            if (trades.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-500 text-sm">No trades found for this student.</td></tr>';
                return;
            }

            tbody.innerHTML = trades.map(t => `
                <tr class="hover:bg-slate-800/30 border-b border-slate-800/50">
                    <td class="p-4 text-xs text-slate-400">${t.openTime ? new Date(t.openTime.seconds * 1000).toLocaleDateString() : '-'}</td>
                    <td class="p-4 text-xs font-bold text-white">${t.instrument}</td>
                    <td class="p-4"><span class="px-2 py-0.5 rounded text-[9px] font-black uppercase ${t.type === 'buy' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">${t.type}</span></td>
                    <td class="p-4 text-xs font-mono text-slate-400">${t.lots}</td>
                    <td class="p-4 text-xs font-mono font-bold ${t.pnl >= 0 ? 'profit-text' : 'loss-text'}">$${t.pnl?.toFixed(2) || '0.00'}</td>
                    <td class="p-4 text-[10px] uppercase font-bold text-slate-500">${t.status}</td>
                </tr>
            `).join('');
        });
}

function loadStudentComments(uid) {
    db.collection('users').doc(uid).collection('comments')
        .orderBy('createdAt', 'desc')
        .onSnapshot(snap => {
            const list = document.getElementById('commentsList');
            if (snap.empty) {
                list.innerHTML = '<p class="text-xs text-slate-500 italic">No feedback yet.</p>';
                return;
            }
            list.innerHTML = snap.docs.map(doc => {
                const c = doc.data();
                return `
                    <div class="bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                        <p class="text-xs text-slate-300">${c.text}</p>
                        <p class="text-[9px] text-slate-600 mt-1 text-right">${c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleString() : ''}</p>
                    </div>
                `;
            }).join('');
        });
}

document.getElementById('commentForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!selectedStudentId) return;
    
    const text = document.getElementById('commentInput').value;
    if (!text.trim()) return;

    await db.collection('users').doc(selectedStudentId).collection('comments').add({
        text: text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        author: 'Admin'
    });
    
    document.getElementById('commentInput').value = '';
};

function refreshTrades() {
    if (selectedStudentId) loadStudentTrades(selectedStudentId);
}
