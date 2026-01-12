const firebaseConfig = {
    apiKey: "AIzaSyAVd8ZiE59c5gNFyX9K8K-HGm6natzSLsw",
    authDomain: "skillforge-trading-journal.firebaseapp.com",
    projectId: "skillforge-trading-journal",
    storageBucket: "skillforge-trading-journal.firebasestorage.app",
    messagingSenderId: "456859128026",
    appId: "1:456859128026:web:bdab9707425d19807a55e3",
    measurementId: "G-32Z5D74LT9"
};

// Initialize Firebase safely
let db, auth;

try {
    if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
        auth = firebase.auth();
    } else {
        console.warn('Firebase SDK not loaded. Check internet connection.');
    }
} catch (e) {
    console.error('Firebase initialization error:', e);
}

// Global State
let marketData = [];
let trades = [];
let tradeSide = 'buy';
let currentTab = 'active';
let currentEditTradeId = null;
let derivWS = null;
let trailingSettings = {};
let lastSLWriteTime = {};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('App Initialization Started');

    try {
        // 1. Setup UI Event Listeners (CRITICAL: Do this first!)
        // This ensures buttons work even if other things fail
        setupUIListeners();

        // 2. Initialize Icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        // 3. Initialize Deriv (Market Data)
        try {
            initDerivConnection();
        } catch (e) {
            console.warn('Deriv connection failed:', e);
        }
        
        // 4. Setup Auth Listeners
        setupAuthListeners();

        // 5. Network Listeners
        window.addEventListener('online', () => {
            console.log('Network Online');
            showNotification('Network connected. Reconnecting services...', 'success');
            reconnectAttempts = 0;
            initDerivConnection();
        });

        window.addEventListener('offline', () => {
            console.log('Network Offline');
            showNotification('Network lost. Check connection.', 'error');
        });

        // Signal successful boot for index.html monitor
        window.appInitialized = true;

    } catch (e) {
        console.error('Critical Initialization Error:', e);
        alert('App Error: ' + e.message);
        window.appInitialized = false;
    }
});

function setupUIListeners() {
    const btnLogin = document.getElementById('btn-show-login');
    const btnRegister = document.getElementById('btn-show-register');
    const btnAdmin = document.getElementById('btn-show-admin');
    const btnBack = document.getElementById('btn-back-auth');
    const btnExport = document.getElementById('btn-export-csv');

    // Debug logs to help identify issues
    if(!btnLogin) console.warn('Login button not found');
    if(!btnRegister) console.warn('Register button not found');

    if(btnLogin) btnLogin.addEventListener('click', () => { console.log('Login Clicked'); showAuthForm('login'); });
    if(btnRegister) btnRegister.addEventListener('click', () => { console.log('Register Clicked'); showAuthForm('register'); });
    if(btnAdmin) btnAdmin.addEventListener('click', () => { console.log('Admin Clicked'); showAuthForm('admin'); });
    if(btnBack) btnBack.addEventListener('click', resetAuthView);
    if(btnExport) btnExport.addEventListener('click', exportCSV);

    const authForm = document.getElementById('authForm');
    const adminForm = document.getElementById('adminForm');

    if(authForm) authForm.onsubmit = handleStudentAuth;
    if(adminForm) adminForm.onsubmit = handleAdminAuth;

    const fInst = document.getElementById('filterInstrument');
    const fSide = document.getElementById('filterSide');
    const fTag = document.getElementById('filterTag');
    const fFrom = document.getElementById('filterFrom');
    const fTo = document.getElementById('filterTo');
    [fInst, fSide, fTag, fFrom, fTo].forEach(el => {
        if(el) el.addEventListener('input', renderHistory);
        if(el) el.addEventListener('change', renderHistory);
    });
}

function setupAuthListeners() {
    if (typeof auth !== 'undefined' && auth) {
        auth.onAuthStateChanged(user => {
            if (user) {
                console.log('User Logged In:', user.email);
                document.getElementById('authContainer').classList.add('hidden');
                document.getElementById('appContent').classList.remove('hidden');
                loadUserTrades(user.uid);
                loadLeaderboard();
                if(typeof loadFeedback === 'function') loadFeedback();
                
                if(db) {
                    db.collection('users').doc(user.uid).set({
                        email: user.email,
                        lastLogin: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true }).catch(err => console.error('Error updating user:', err));
                }
            } else {
                console.log('User Logged Out');
                document.getElementById('authContainer').classList.remove('hidden');
                document.getElementById('appContent').classList.add('hidden');
            }
        });
    } else {
        // Offline/No-Firebase Fallback
        console.warn('Running in offline/demo mode (Auth disabled)');
        showNotification('Firebase not loaded. Auth disabled.', 'error');
    }
}

// --- Deriv API & WebSocket ---
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000; // Start with 2s
let heartbeatInterval = null;
let connectionWatchdog = null;

function initDerivConnection() {
    // Prevent multiple simultaneous connection attempts
    if(derivWS && (derivWS.readyState === WebSocket.CONNECTING || derivWS.readyState === WebSocket.OPEN)) {
        return;
    }

    // Clean up existing socket if needed
    if(derivWS) {
        try {
            derivWS.close();
        } catch(e) { /* ignore */ }
    }

    console.log(`Connecting to Deriv (Attempt ${reconnectAttempts + 1})...`);
    derivWS = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
    
    derivWS.onopen = () => {
        console.log('Deriv WS Connected');
        setConnectionStatus('connected');
        reconnectAttempts = 0; // Reset counter on successful connection
        
        // Start Heartbeat/Watchdog
        startHeartbeat();

        // Fetch Active Symbols
        safeSend({ 
            active_symbols: "brief", 
            product_type: "basic" 
        });
    };

    derivWS.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            
            // Reset watchdog on any message
            resetWatchdog();

            if (data.msg_type === 'active_symbols') {
                processActiveSymbols(data.active_symbols);
            } else if (data.msg_type === 'tick') {
                updatePrice(data.tick);
            } else if (data.error) {
                console.warn('Deriv API Error:', data.error.message);
                // Don't disconnect on API errors, just log (unless critical)
            }
        } catch (e) {
            console.error('Error parsing WS message:', e);
        }
    };

    derivWS.onclose = (event) => {
        console.log('Deriv WS Closed:', event.code, event.reason);
        setConnectionStatus('disconnected');
        stopHeartbeat();
        
        // Smart Reconnection
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), 30000); // Cap at 30s
        
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            console.log(`Reconnecting in ${delay}ms...`);
            setTimeout(() => {
                reconnectAttempts++;
                initDerivConnection();
            }, delay);
        } else {
            console.error('Max reconnect attempts reached. Please refresh.');
            showNotification('Connection lost. Please refresh the page.', 'error');
        }
    };
    
    derivWS.onerror = (err) => {
        console.error('Deriv WS Error:', err);
        // onError usually precedes onClose, so we let onClose handle the reconnection
    };
}

function safeSend(data) {
    if(derivWS && derivWS.readyState === WebSocket.OPEN) {
        derivWS.send(JSON.stringify(data));
    }
}

function startHeartbeat() {
    stopHeartbeat();
    // Send a 'ping' every 30 seconds to keep connection alive
    heartbeatInterval = setInterval(() => {
        safeSend({ ping: 1 });
    }, 30000);
    
    // Watchdog: If no message received for 40 seconds, assume dead and reconnect
    resetWatchdog();
}

function stopHeartbeat() {
    if(heartbeatInterval) clearInterval(heartbeatInterval);
    if(connectionWatchdog) clearTimeout(connectionWatchdog);
}

function resetWatchdog() {
    if(connectionWatchdog) clearTimeout(connectionWatchdog);
    connectionWatchdog = setTimeout(() => {
        console.warn('Connection timed out (no data). Reconnecting...');
        if(derivWS) derivWS.close(); // This will trigger onclose and reconnection logic
    }, 40000); // 40s timeout (slightly longer than ping interval)
}

function setConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    if(!el) return;
    
    if(status === 'connected') {
        el.innerHTML = `<div class="live-indicator"></div><span class="text-slate-400 font-medium">LIVE DATA</span>`;
        el.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-xs";
    } else {
        el.innerHTML = `<div class="w-2 h-2 rounded-full bg-red-500"></div><span class="text-red-400 font-medium">OFFLINE</span>`;
        el.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-900/20 border border-red-900/50 text-xs";
    }
}

function processActiveSymbols(symbols) {
    // Broaden filter to include more categories as requested
    marketData = symbols.filter(s => s.exchange_is_open === 1).map(s => ({
        symbol: s.display_name,
        deriv: s.symbol,
        cat: mapCategory(s.market),
        market_display: s.market_display_name,
        digit: s.pip.toString().split('.')[1]?.length || 2,
        price: 0
    }));

    populateInstrumentSelect();
    subscribeToTicks();
}

function mapCategory(market) {
    if (market === 'synthetic_index') return 'SYN';
    if (market === 'forex') return 'FX';
    if (market === 'cryptocurrency') return 'CRY';
    if (market === 'indices') return 'IDX';
    if (market === 'commodities') return 'COM';
    return 'OTC';
}

function subscribeToTicks() {
    // Subscribe to top 50 popular assets for the ticker
    // In a real app, we'd manage this more dynamically to stay within limits
    const symbols = marketData.slice(0, 50).map(m => m.deriv);
    if(derivWS && derivWS.readyState === WebSocket.OPEN) {
        derivWS.send(JSON.stringify({ ticks: symbols }));
    }
}

function updatePrice(tick) {
    const item = marketData.find(m => m.deriv === tick.symbol);
    if (item) {
        item.price = tick.quote;
        // Debounce render to avoid UI lag
        requestAnimationFrame(renderTickers);
    }
    // Update active trades PnL in real-time
    updateActiveTradesPnL(tick);
}

function populateInstrumentSelect() {
    const s = document.getElementById('f-instrument');
    const categories = {};
    
    // Group by category
    marketData.forEach(m => {
        if (!categories[m.market_display]) categories[m.market_display] = [];
        categories[m.market_display].push(m);
    });

    s.innerHTML = Object.keys(categories).sort().map(cat => `
        <optgroup label="${cat}">
            ${categories[cat].map(m => `<option value="${m.symbol}">${m.symbol}</option>`).join('')}
        </optgroup>
    `).join('');
    
    s.addEventListener('change', () => {
        const inst = marketData.find(m => m.symbol === s.value);
        if(inst) {
            // Subscribe to this specific instrument if not already
            safeSend({ ticks: [inst.deriv] });
            if(inst.price > 0) document.getElementById('f-entry').value = inst.price;
        }
    });
}
function updateActiveTradesPnL(tick) {
    if(currentTab !== 'active') return;
    
    // Find trades using this symbol
    const relevantTrades = trades.filter(t => {
        const item = marketData.find(m => m.symbol === t.instrument);
        return item && item.deriv === tick.symbol;
    });

    relevantTrades.forEach(t => {
        const inst = marketData.find(m => m.symbol === t.instrument);
        const settings = trailingSettings[t.id];
        if(inst && settings && settings.enabled) {
            const price = tick.quote;
            applyTrailingStop(t, inst, price, settings.distancePips);
        }
    });

    if(relevantTrades.length > 0) {
        renderActiveTrades(); // Re-render to show new PnL
    }
}

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

// --- Auth Logic ---
function showAuthForm(type) {
    document.getElementById('landing-options').classList.add('hidden');
    document.getElementById('auth-forms').classList.remove('hidden');
    
    document.getElementById('authForm').classList.add('hidden');
    document.getElementById('adminForm').classList.add('hidden');
    document.getElementById('auth-title').innerText = '';

    if (type === 'login' || type === 'register') {
        document.getElementById('authForm').classList.remove('hidden');
        const isRegister = type === 'register';
        document.getElementById('auth-title').innerText = isRegister ? 'Student Registration' : 'Student Login';
        document.getElementById('btn-auth-action').innerText = isRegister ? 'Create Account' : 'Access Journal';
        document.getElementById('authForm').dataset.mode = type;
    } else {
        document.getElementById('adminForm').classList.remove('hidden');
        document.getElementById('auth-title').innerText = 'Mentor Access';
    }
}

function resetAuthView() {
    document.getElementById('landing-options').classList.remove('hidden');
    document.getElementById('auth-forms').classList.add('hidden');
}

async function handleStudentAuth(e) {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const mode = e.target.dataset.mode;

    try {
        if (mode === 'register') {
            await auth.createUserWithEmailAndPassword(email, password);
            showNotification('Account created successfully!', 'success');
        } else {
            await auth.signInWithEmailAndPassword(email, password);
            showNotification('Welcome back!', 'success');
        }
    } catch (error) {
        showNotification(error.message, 'error');
    }
}

function handleAdminAuth(e) {
    e.preventDefault();
    const code = document.getElementById('adminPasscode').value;
    if (code === '#Skillmindset1#') {
        window.location.href = 'admin.html';
    } else {
        showNotification('Access Denied: Invalid Mentor Passcode', 'error');
    }
}


let tvWidget = null;
function toggleChart() {
    const s = document.getElementById('chartSection');
    s.classList.toggle('hidden');
    
    if (!s.classList.contains('hidden') && !tvWidget) {
        tvWidget = new TradingView.widget({
            "width": "100%", "height": 500, "symbol": "DERIV:R_75",
            "interval": "D", "timezone": "Etc/UTC", "theme": "dark",
            "style": "1", "locale": "en", "toolbar_bg": "#f1f3f6",
            "enable_publishing": false, "allow_symbol_change": true,
            "container_id": "tv-container"
        });
    }
}

function switchTab(tab) {
    currentTab = tab;
    // Reset classes
    ['active', 'history', 'leaderboard', 'feedback'].forEach(t => {
        const btn = document.getElementById(`tab-${t}`);
        if(t === tab) {
            btn.className = "px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all bg-slate-800 text-blue-400 shadow-lg border border-slate-700";
        } else {
            btn.className = "px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all text-slate-500 hover:text-slate-300";
        }
    });

    document.getElementById('activeTradesList').classList.add('hidden');
    document.getElementById('historyList').classList.add('hidden');
    document.getElementById('leaderboardList').classList.add('hidden');
    document.getElementById('feedbackList').classList.add('hidden');

    if (tab === 'active') {
        document.getElementById('activeTradesList').classList.remove('hidden');
        renderActiveTrades();
    } else if (tab === 'history') {
        document.getElementById('historyList').classList.remove('hidden');
        renderHistory();
    } else if (tab === 'leaderboard') {
        document.getElementById('leaderboardList').classList.remove('hidden');
        loadLeaderboard();
    } else if (tab === 'feedback') {
        document.getElementById('feedbackList').classList.remove('hidden');
        loadFeedback();
    }
}

function setSide(side) {
    tradeSide = side;
    document.getElementById('btn-buy').className = side === 'buy' ? "flex-1 py-2 rounded text-[10px] font-black uppercase bg-green-600 text-white shadow-lg" : "flex-1 py-2 rounded text-[10px] font-black uppercase text-slate-500";
    document.getElementById('btn-sell').className = side === 'sell' ? "flex-1 py-2 rounded text-[10px] font-black uppercase bg-red-600 text-white shadow-lg" : "flex-1 py-2 rounded text-[10px] font-black uppercase text-slate-500";
}

function openModal() { document.getElementById('tradeModal').classList.add('active'); }
function closeModal() { document.getElementById('tradeModal').classList.remove('active'); }
function closeEditModal() { document.getElementById('editModal').classList.remove('active'); }
function logout() { auth.signOut(); }

function renderTickers() {
    const q = document.getElementById('marketSearch').value.toLowerCase();
    const filtered = marketData.filter(m => m.symbol.toLowerCase().includes(q));
    document.getElementById('tickerContainer').innerHTML = filtered.map(t => `
        <div class="glass min-w-[120px] p-2 rounded-lg border border-slate-800">
            <p class="text-[9px] font-bold text-slate-500 uppercase">${t.cat}</p>
            <p class="text-xs font-black text-blue-100 truncate">${t.symbol}</p>
            <p class="text-xs font-mono text-white mt-1">${t.price > 0 ? t.price.toFixed(t.digit) : '...'}</p>
        </div>
    `).join('');
}

document.getElementById('marketSearch').oninput = renderTickers;

// --- Trade Logic ---

function loadUserTrades(uid) {
    db.collection('users').doc(uid).collection('trades')
        .onSnapshot(snap => {
            trades = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            trades.sort((a,b) => (b.openTime?.toMillis() || 0) - (a.openTime?.toMillis() || 0));
            updateStats();
            if(currentTab === 'active') renderActiveTrades();
            if(currentTab === 'history') renderHistory();
        });
}

document.getElementById('tradeForm').onsubmit = async (e) => {
    e.preventDefault();
    const instName = document.getElementById('f-instrument').value;
    const inst = marketData.find(m => m.symbol === instName);
    const user = auth.currentUser;
    
    const entry = parseFloat(document.getElementById('f-entry').value) || inst.price;
    const sl = parseFloat(document.getElementById('f-sl').value) || 0;
    const tp = parseFloat(document.getElementById('f-tp').value) || 0;
    const strategy = document.getElementById('f-strategy').value || '';
    const setup = document.getElementById('f-setup').value || '';
    const tagsStr = document.getElementById('f-tags').value || '';
    const riskpct = parseFloat(document.getElementById('f-riskpct').value) || 0;
    const plannedRR = computePlannedRR(tradeSide, entry, sl, tp);
    
    await db.collection('users').doc(user.uid).collection('trades').add({
        instrument: instName,
        type: tradeSide,
        lots: parseFloat(document.getElementById('f-lots').value) || 0.01,
        entryPrice: entry,
        stopLoss: sl,
        takeProfit: tp,
        strategy: strategy,
        setup: setup,
        tags: tagsStr.split(',').map(s => s.trim()).filter(Boolean),
        riskPercent: riskpct,
        plannedRR: plannedRR,
        status: 'running',
        openTime: firebase.firestore.FieldValue.serverTimestamp()
    });
    closeModal();
    e.target.reset();
};

function calculateMetrics(trade, currentPrice) {
    if (!currentPrice) return { profit: 0, pips: 0 };
    
    const inst = marketData.find(m => m.symbol === trade.instrument);
    let diff = trade.type === 'buy' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice);
    
    let pipValue = 1;
    let pipMultiplier = 1;

    // Pip Calculations
    if (inst.cat === 'FX') {
        if (inst.symbol.includes('JPY')) {
            pipMultiplier = 100;
        } else {
            pipMultiplier = 10000;
        }
    } else if (inst.cat === 'COM' && (inst.symbol.includes('Gold') || inst.symbol.includes('XAU'))) { 
        pipMultiplier = 10; 
    } else if (inst.cat === 'CRY') {
        pipMultiplier = 1; // Points
    } else {
        pipMultiplier = 1; // Synthetics/Indices/Others points
    }

    const pips = diff * pipMultiplier;
    const profit = pips * trade.lots; // Simplified linear calculation
    // Note: Accurate forex PnL requires tick value, keeping it simplified as requested
    
    return { 
        profit: profit.toFixed(2), 
        pips: pips.toFixed(1),
        isProfit: profit >= 0 
    };
}

function renderActiveTrades() {
    const active = trades.filter(t => t.status === 'running');
    const container = document.getElementById('activeTradesList');
    
    if (active.length === 0) {
        container.innerHTML = `<div class="col-span-full py-20 text-center text-slate-500 text-sm font-bold uppercase tracking-wider opacity-50 border-2 border-dashed border-slate-800 rounded-2xl">No Active Positions</div>`;
        return;
    }

    container.innerHTML = active.map(t => {
        // Use live price if available, else entry price (0 PnL)
        const current = marketData.find(m => m.symbol === t.instrument);
        const currentPrice = current ? current.price : t.entryPrice;
        const { profit, pips, isProfit } = calculateMetrics(t, currentPrice);

        return `
            <div class="glass p-5 rounded-2xl border border-slate-800 relative group hover:border-slate-600 transition-all ${isProfit ? 'shadow-green-900/10' : 'shadow-red-900/10'} shadow-xl">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs font-black text-white bg-slate-800 px-2 py-0.5 rounded uppercase tracking-wider">${t.instrument}</span>
                            <span class="text-[10px] font-bold ${t.type === 'buy' ? 'text-green-500' : 'text-red-500'} bg-slate-950 px-2 py-0.5 rounded uppercase">${t.type}</span>
                        </div>
                        <span class="text-[10px] text-slate-500 font-mono">#${t.id.slice(0,6)}</span>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-black font-mono ${isProfit ? 'text-green-500' : 'text-red-500'}">${isProfit ? '+' : ''}${profit}</div>
                        <div class="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Floating PnL</div>
                    </div>
                </div>
                
                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div class="bg-slate-900/50 p-2 rounded-lg">
                        <p class="text-[10px] text-slate-500 uppercase mb-0.5">Entry Price</p>
                        <p class="font-mono text-xs text-white">${t.entryPrice}</p>
                    </div>
                    <div class="bg-slate-900/50 p-2 rounded-lg">
                        <p class="text-[10px] text-slate-500 uppercase mb-0.5">Current Price</p>
                        <p class="font-mono text-xs text-white">${currentPrice || '---'}</p>
                    </div>
                </div>

                <div class="flex items-center gap-2 text-[10px] text-slate-400 font-mono mb-4">
                    <span>SL: <span class="text-red-400">${t.stopLoss || '---'}</span></span>
                    <span>•</span>
                    <span>TP: <span class="text-green-400">${t.takeProfit || '---'}</span></span>
                    <span class="ml-auto text-xs font-bold ${isProfit ? 'text-green-500' : 'text-red-500'}">${pips} Pips</span>
                </div>

                <button onclick="openEditModal('${t.id}')" class="w-full py-2.5 bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2">
                    <i data-lucide="settings-2" class="w-3.5 h-3.5"></i> Manage Position
                </button>
            </div>
        `;
    }).join('');
    lucide.createIcons();
}

// --- Leaderboard & Feedback ---

async function loadLeaderboard() {
    const container = document.getElementById('leaderboardContent');
    if(!container) return;

    try {
        // Note: In a real production app, this should be a cloud function to avoid fetching all users on client
        // For this scale, client-side aggregation is acceptable
        const usersSnap = await db.collection('users').get();
        const leaderboard = [];

        for (const doc of usersSnap.docs) {
            const tradesSnap = await db.collection('users').doc(doc.id).collection('trades').where('status', '==', 'closed').get();
            let totalPnL = 0;
            let wins = 0;
            const totalTrades = tradesSnap.size;

            tradesSnap.forEach(t => {
                const data = t.data();
                const pnl = data.pnl || 0;
                totalPnL += pnl;
                if(pnl > 0) wins++;
            });

            if (totalTrades > 0) {
                leaderboard.push({
                    email: doc.data().email,
                    pnl: totalPnL,
                    winRate: (wins / totalTrades) * 100
                });
            }
        }

        leaderboard.sort((a, b) => b.pnl - a.pnl);

        if (leaderboard.length === 0) {
            container.innerHTML = '<p class="text-center text-slate-500 text-xs py-10">No active traders yet.</p>';
            return;
        }

        container.innerHTML = leaderboard.slice(0, 10).map((u, i) => `
            <div class="flex items-center justify-between p-4 bg-slate-900/30 rounded-xl border border-slate-800 ${i === 0 ? 'border-yellow-500/50 bg-yellow-900/10' : ''}">
                <div class="flex items-center gap-4">
                    <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${i === 0 ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-slate-400'}">
                        ${i + 1}
                    </div>
                    <div>
                        <p class="text-sm font-bold text-white">${u.email.split('@')[0]}</p>
                        <p class="text-[10px] text-slate-500">${u.winRate.toFixed(1)}% Win Rate</p>
                    </div>
                </div>
                <div class="text-right">
                    <p class="font-mono font-bold ${u.pnl >= 0 ? 'text-green-400' : 'text-red-400'}">${u.pnl >= 0 ? '+' : ''}${u.pnl.toFixed(2)}</p>
                </div>
            </div>
        `).join('');

    } catch (e) {
        console.error(e);
        container.innerHTML = '<p class="text-center text-red-500 text-xs">Error loading leaderboard.</p>';
    }
}

function loadFeedback() {
    const user = auth.currentUser;
    if(!user) return;
    const container = document.getElementById('feedbackContent');

    db.collection('users').doc(user.uid).collection('comments')
        .orderBy('createdAt', 'desc')
        .onSnapshot(snap => {
            if (snap.empty) {
                container.innerHTML = '<div class="text-center py-10"><div class="inline-flex p-4 rounded-full bg-slate-900 mb-3"><i data-lucide="message-square" class="text-slate-600"></i></div><p class="text-slate-500 text-xs">No feedback from mentors yet.</p></div>';
                lucide.createIcons();
                return;
            }

            container.innerHTML = snap.docs.map(doc => {
                const c = doc.data();
                return `
                    <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800 relative">
                        <div class="absolute top-4 right-4 text-[9px] text-slate-600 font-mono">
                            ${c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleDateString() : 'Just now'}
                        </div>
                        <div class="flex items-start gap-3">
                            <div class="bg-blue-900/30 p-2 rounded-lg">
                                <i data-lucide="user-check" class="w-4 h-4 text-blue-400"></i>
                            </div>
                            <div>
                                <h4 class="text-xs font-bold text-blue-200 mb-1">Mentor Feedback</h4>
                                <p class="text-sm text-slate-300 leading-relaxed">${c.text}</p>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            lucide.createIcons();
        });
}

function renderHistory() {
    let history = trades.filter(t => t.status === 'closed');
    const qInst = (document.getElementById('filterInstrument')?.value || '').toLowerCase();
    const qSide = document.getElementById('filterSide')?.value || '';
    const qTag = (document.getElementById('filterTag')?.value || '').toLowerCase();
    const qFrom = document.getElementById('filterFrom')?.value || '';
    const qTo = document.getElementById('filterTo')?.value || '';
    if(qInst) history = history.filter(t => (t.instrument || '').toLowerCase().includes(qInst));
    if(qSide) history = history.filter(t => (t.type || '') === qSide);
    if(qTag) history = history.filter(t => Array.isArray(t.tags) && t.tags.some(tag => tag.toLowerCase().includes(qTag)));
    if(qFrom) history = history.filter(t => t.closeTime && new Date(t.closeTime.seconds * 1000) >= new Date(qFrom));
    if(qTo) history = history.filter(t => t.closeTime && new Date(t.closeTime.seconds * 1000) <= new Date(qTo));
    const tbody = document.getElementById('historyTableBody');
    
    if (history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-20 text-center text-slate-500 text-sm font-bold uppercase tracking-wider opacity-50">No History Records</td></tr>`;
        return;
    }

    tbody.innerHTML = history.map(t => {
        const pnl = t.pnl || 0;
        const isWin = pnl >= 0;
        return `
            <tr class="hover:bg-slate-800/30 transition-colors border-b border-slate-800/50 last:border-0">
                <td class="p-5 font-bold text-white text-xs">${t.instrument}</td>
                <td class="p-5"><span class="${t.type === 'buy' ? 'text-green-500' : 'text-red-500'} font-bold text-[10px] uppercase bg-slate-900 px-2 py-1 rounded">${t.type}</span></td>
                <td class="p-5 font-mono text-xs text-slate-300">${t.lots}</td>
                <td class="p-5">
                    <div class="flex flex-col gap-1">
                        <span class="font-mono text-[10px] text-slate-400">In: ${t.entryPrice}</span>
                        <span class="font-mono text-[10px] text-slate-400">Out: ${t.closePrice || '---'}</span>
                    </div>
                </td>
                <td class="p-5 font-mono text-xs ${t.pips >= 0 ? 'text-green-500' : 'text-red-500'}">${t.pips || 0}</td>
                <td class="p-5 text-right font-mono text-sm font-bold ${isWin ? 'text-green-400' : 'text-red-400'}">${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}</td>
                <td class="p-5 text-right">
                    <span class="text-[10px] text-slate-500">${t.closeTime ? new Date(t.closeTime.seconds * 1000).toLocaleDateString() : '-'}</span>
                </td>
            </tr>
        `;
    }).join('');
    lucide.createIcons();
}

function openEditModal(id) {
    const t = trades.find(tr => tr.id === id);
    if(!t) return;
    currentEditTradeId = id;
    
    const inst = marketData.find(m => m.symbol === t.instrument);
    const currentPrice = inst && inst.price > 0 ? inst.price : t.entryPrice;

    document.getElementById('edit-id').value = id;
    document.getElementById('e-sl').value = t.stopLoss || '';
    document.getElementById('e-current-price').value = currentPrice;
    const s = trailingSettings[id] || { enabled: false, distancePips: 10 };
    const eEnable = document.getElementById('e-trailing-enable');
    const ePips = document.getElementById('e-trailing-pips');
    if(eEnable) eEnable.checked = !!s.enabled;
    if(ePips) ePips.value = s.distancePips;
    if(eEnable) eEnable.onchange = () => setTrailingEnabled(id, eEnable.checked);
    if(ePips) ePips.oninput = () => setTrailingPips(id, parseFloat(ePips.value) || 0);
    
    document.getElementById('editModal').classList.add('active');
}

function moveToBE() {
    const id = currentEditTradeId;
    const t = trades.find(tr => tr.id === id);
    if(t) document.getElementById('e-sl').value = t.entryPrice;
}

async function updateTrade() {
    const id = currentEditTradeId;
    const sl = parseFloat(document.getElementById('e-sl').value) || 0;
    
    await db.collection('users').doc(auth.currentUser.uid).collection('trades').doc(id).update({
        stopLoss: sl
    });
    closeEditModal();
}

async function confirmCloseTrade() {
    const id = currentEditTradeId;
    const t = trades.find(tr => tr.id === id);
    const closePrice = parseFloat(document.getElementById('e-current-price').value) || t.entryPrice;
    const closeNote = document.getElementById('e-note')?.value || '';
    
    const { profit, pips } = calculateMetrics(t, closePrice);
    
    await db.collection('users').doc(auth.currentUser.uid).collection('trades').doc(id).update({
        status: 'closed',
        closePrice: closePrice,
        pnl: parseFloat(profit),
        pips: parseFloat(pips),
        closeTime: firebase.firestore.FieldValue.serverTimestamp(),
        closeNote: closeNote
    });
    closeEditModal();
}

function updateStats() {
    const closed = trades.filter(t => t.status === 'closed');
    const totalPnl = closed.reduce((acc, curr) => acc + (curr.pnl || 0), 0);
    const totalLots = trades.reduce((acc, curr) => acc + (curr.lots || 0), 0);
    const wins = closed.filter(t => (t.pnl || 0) > 0).length;
    const winRateNum = closed.length > 0 ? (wins / closed.length * 100) : 0;
    const active = trades.filter(t => t.status === 'running').length;
    document.getElementById('totalPnl').innerText = `$${totalPnl.toFixed(2)}`;
    document.getElementById('totalPnl').className = `text-xl font-bold font-mono ${totalPnl >= 0 ? 'profit-text' : 'loss-text'}`;
    document.getElementById('totalLots').innerText = totalLots.toFixed(2);
    document.getElementById('winRate').innerText = `${winRateNum.toFixed(0)}%`;
    document.getElementById('activeCount').innerText = active;
    renderEquityCurve(closed);
}

// --- Leaderboard ---
async function loadLeaderboard() {
    // This is a simplified leaderboard that requires reading all users. 
    // In production, you'd use a cloud function to aggregate this.
    // Assuming read access to 'users' collection for now.
    
    try {
        const snap = await db.collection('users').get();
        const leaderboardData = [];
        
        for (const userDoc of snap.docs) {
            const userData = userDoc.data();
            const tradesSnap = await userDoc.ref.collection('trades').where('status', '==', 'closed').get();
            let totalPnl = 0;
            tradesSnap.forEach(t => totalPnl += (t.data().pnl || 0));
            
            leaderboardData.push({
                email: userData.email,
                pnl: totalPnl
            });
        }
        
        leaderboardData.sort((a,b) => b.pnl - a.pnl);
        
        document.getElementById('leaderboardContent').innerHTML = leaderboardData.map((u, index) => `
            <div class="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                <div class="flex items-center gap-3">
                    <div class="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold">
                        ${index + 1}
                    </div>
                    <span class="text-sm text-slate-300 font-bold">${u.email.split('@')[0]}</span>
                </div>
                <span class="font-mono font-bold ${u.pnl >= 0 ? 'profit-text' : 'loss-text'}">$${u.pnl.toFixed(2)}</span>
            </div>
        `).join('');
        
    } catch (e) {
        console.error("Leaderboard error:", e);
        document.getElementById('leaderboardContent').innerHTML = `<p class="text-slate-500 text-xs text-center">Leaderboard unavailable (requires admin/public permissions)</p>`;
    }
}

function loadFeedback() {
    const user = auth.currentUser;
    if (!user) return;
    
    db.collection('users').doc(user.uid).collection('comments')
        .orderBy('createdAt', 'desc')
        .onSnapshot(snap => {
            const container = document.getElementById('feedbackContent');
            if (snap.empty) {
                container.innerHTML = `<p class="text-slate-500 text-sm text-center">No feedback yet.</p>`;
                return;
            }
            
            container.innerHTML = snap.docs.map(doc => {
                const c = doc.data();
                return `
                    <div class="bg-slate-800/50 p-4 rounded-xl border border-slate-700">
                        <div class="flex items-center gap-2 mb-2">
                            <div class="w-2 h-2 rounded-full bg-blue-500"></div>
                            <span class="text-xs font-bold text-blue-400 uppercase">Instructor Feedback</span>
                            <span class="text-[10px] text-slate-500 ml-auto">${c.createdAt ? new Date(c.createdAt.seconds * 1000).toLocaleString() : ''}</span>
                        </div>
                        <p class="text-sm text-slate-300">${c.text}</p>
                    </div>
                `;
            }).join('');
        });
}

function addTradeNote() {
    const id = currentEditTradeId;
    const text = document.getElementById('e-note')?.value || '';
    if(!id || !text.trim()) return;
    db.collection('users').doc(auth.currentUser.uid).collection('trades').doc(id)
      .collection('journal').add({
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(() => {
        document.getElementById('e-note').value = '';
        showNotification('Note added', 'success');
      }).catch(() => showNotification('Failed to add note', 'error'));
}

function setTrailingEnabled(id, enabled) {
    trailingSettings[id] = trailingSettings[id] || { enabled: false, distancePips: 10 };
    trailingSettings[id].enabled = enabled;
}

function setTrailingPips(id, pips) {
    trailingSettings[id] = trailingSettings[id] || { enabled: false, distancePips: 10 };
    trailingSettings[id].distancePips = pips;
}

function computePipMultiplier(inst) {
    if (inst.cat === 'FX') {
        if (inst.symbol.includes('JPY')) return 100;
        return 10000;
    } else if (inst.cat === 'COM' && (inst.symbol.includes('Gold') || inst.symbol.includes('XAU'))) {
        return 10;
    } else if (inst.cat === 'CRY') {
        return 1;
    } else {
        return 1;
    }
}

function applyTrailingStop(t, inst, currentPrice, distancePips) {
    const mult = computePipMultiplier(inst);
    const delta = distancePips / mult;
    let newSL = t.stopLoss || 0;
    if(t.type === 'buy') {
        if(currentPrice > t.entryPrice) {
            const candidate = currentPrice - delta;
            if(candidate > newSL) newSL = candidate;
        }
    } else {
        if(currentPrice < t.entryPrice) {
            const candidate = currentPrice + delta;
            if(newSL === 0 || candidate < newSL) newSL = candidate;
        }
    }
    const minStep = 1 / mult;
    const last = lastSLWriteTime[t.id] || 0;
    if(Math.abs(newSL - (t.stopLoss || 0)) > minStep && Date.now() - last > 4000) {
        lastSLWriteTime[t.id] = Date.now();
        db.collection('users').doc(auth.currentUser.uid).collection('trades').doc(t.id).update({
            stopLoss: newSL
        }).catch(() => {});
    }
}
function renderEquityCurve(closed) {
    const container = document.getElementById('equityCurve');
    if(!container) return;
    const sorted = closed.slice().sort((a,b) => {
        const ta = a.closeTime ? a.closeTime.seconds : 0;
        const tb = b.closeTime ? b.closeTime.seconds : 0;
        return ta - tb;
    });
    let points = [];
    let cum = 0;
    sorted.forEach((t, i) => {
        cum += t.pnl || 0;
        points.push({ x: i, y: cum });
    });
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 220;
    const maxY = points.length ? Math.max(...points.map(p => p.y)) : 1;
    const minY = points.length ? Math.min(...points.map(p => p.y)) : -1;
    const spanY = maxY - minY || 1;
    const scaleX = points.length > 1 ? (w - 20) / (points.length - 1) : 1;
    const path = points.map((p, i) => {
        const x = 10 + i * scaleX;
        const y = 10 + (h - 20) - ((p.y - minY) / spanY) * (h - 20);
        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
    const color = (points.length && points[points.length - 1].y >= 0) ? '#4ade80' : '#f87171';
    container.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

function exportCSV() {
    const headers = ['id','instrument','type','lots','entryPrice','stopLoss','takeProfit','status','openTime','closePrice','pnl','pips','closeTime','strategy','setup','tags','riskPercent','plannedRR'];
    const rows = trades.map(t => {
        const open = t.openTime ? new Date(t.openTime.seconds * 1000).toISOString() : '';
        const close = t.closeTime ? new Date(t.closeTime.seconds * 1000).toISOString() : '';
        const tags = Array.isArray(t.tags) ? t.tags.join('|') : '';
        return [
            t.id,
            t.instrument || '',
            t.type || '',
            t.lots || '',
            t.entryPrice || '',
            t.stopLoss || '',
            t.takeProfit || '',
            t.status || '',
            open,
            t.closePrice || '',
            t.pnl || '',
            t.pips || '',
            close,
            t.strategy || '',
            t.setup || '',
            tags,
            t.riskPercent || '',
            t.plannedRR || ''
        ].map(v => (typeof v === 'string' && v.includes(',')) ? `"${v}"` : v).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trades.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function computePlannedRR(side, entry, sl, tp) {
    if(!entry || !sl || !tp) return 0;
    if(side === 'buy') {
        const risk = entry - sl;
        const reward = tp - entry;
        if(risk <= 0) return 0;
        return parseFloat((reward / risk).toFixed(2));
    } else {
        const risk = sl - entry;
        const reward = entry - tp;
        if(risk <= 0) return 0;
        return parseFloat((reward / risk).toFixed(2));
    }
}
