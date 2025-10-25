// ====== Utilities ======
function getStore(key){ return JSON.parse(localStorage.getItem(key)||'[]'); }
function setStore(key,val){ localStorage.setItem(key, JSON.stringify(val)); }
function findById(arr,id){ return arr.find(x=>String(x.id)===String(id)); }
function fmtDT(d){ if(!d) return '-'; const t=new Date(d); return isNaN(t)?d:t.toLocaleString(); }
function fmtD(d){ if(!d) return '-'; const t=new Date(d); if(isNaN(t)) return d; return t.toISOString().split('T')[0]; }
function today(){ return (new Date()).toISOString().split('T')[0]; }
function addDays(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; }
function nextCCNo(id){ const y=(new Date()).getFullYear(); return `CC-${y}-${String(id).slice(-5)}`; }
// Generate a unique change request number. Uses the current year and the
// trailing portion of the unique identifier to create human-readable IDs
// (e.g. CR-2025-12345). Aligns with other modules' numbering schemes.
function nextChangeNo(id){ const y=(new Date()).getFullYear(); return `CR-${y}-${String(id).slice(-5)}`; }
function uid(){ return Date.now() + Math.floor(Math.random()*1000); }

// ====== Global variables and initialisation for PWA, IP address and configuration ======
// Global variable to hold the public IP address of the client.  This value is
// fetched from an external API once on application load.  If the request
// fails (for example when offline) then the browser's hostname is used as a
// fallback.  The result is stored in APP_IP and reused for all audit log
// entries so that individual logs capture the actual client network address.
let APP_IP = 'N/A';
if (!window.APP_IP_INITIALIZED) {
  window.APP_IP_INITIALIZED = true;
  try {
    fetch('https://api.ipify.org?format=json')
      .then(r => r.json())
      .then(d => { if (d && d.ip) APP_IP = d.ip; })
      .catch(() => { APP_IP = window.location.hostname || 'N/A'; });
  } catch (e) {
    APP_IP = window.location.hostname || 'N/A';
  }
}

// Register a service worker for progressive web app (PWA) support and offline
// caching.  The service worker script caches key assets during install and
// serves them from cache when offline.  Registration happens once on page
// load and any errors are silently ignored.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// Default configuration values (risk thresholds, retention rules, reminders).
// These helpers read and write configuration objects stored in localStorage.
// Administrators can customise these values via the Settings page.  Each
// module can have its own reminder days and retention period.
function getRiskThresholds() {
  try {
    const t = JSON.parse(localStorage.getItem('riskThresholds') || '{}');
    if (typeof t.low === 'number' && typeof t.medium === 'number' && typeof t.high === 'number') {
      return t;
    }
  } catch (e) {}
  // defaults: low up to 4, medium up to 9, high above 9
  return { low: 4, medium: 8, high: 12 };
}
function setRiskThresholds(thr) {
  if (!thr || typeof thr !== 'object') return;
  localStorage.setItem('riskThresholds', JSON.stringify({
    low: parseFloat(thr.low) || 4,
    medium: parseFloat(thr.medium) || 8,
    high: parseFloat(thr.high) || 12
  }));
}

// Read or write per‑module reminder settings.  These values override the
// default reminder days when sending due‑date reminders.  When not set,
// the default from notificationSettings.reminderDays applies.
function getModuleReminder(module) {
  try {
    const m = JSON.parse(localStorage.getItem('moduleReminders') || '{}');
    if (m[module] !== undefined) return parseInt(m[module]);
  } catch (e) {}
  return null;
}
function setModuleReminder(module, days) {
  try {
    const m = JSON.parse(localStorage.getItem('moduleReminders') || '{}');
    m[module] = parseInt(days);
    localStorage.setItem('moduleReminders', JSON.stringify(m));
  } catch (e) {}
}

// Retention rules per module.  Records older than the specified number of
// days are automatically purged by the system.  A value of null or 0
// disables automatic archival for that module.  The rules are stored in
// localStorage under 'retentionRules'.
function getRetention(module) {
  try {
    const r = JSON.parse(localStorage.getItem('retentionRules') || '{}');
    if (r[module]) return parseInt(r[module]);
  } catch (e) {}
  return null;
}
function setRetention(module, days) {
  try {
    const r = JSON.parse(localStorage.getItem('retentionRules') || '{}');
    r[module] = parseInt(days);
    localStorage.setItem('retentionRules', JSON.stringify(r));
  } catch (e) {}
}

// Helper for date difference in days.  Returns positive integer.
function daysBetween(d1, d2) {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return Math.floor((date2 - date1) / (1000 * 60 * 60 * 24));
}

// Purge old records based on retention rules.  For each module with a
// configured retention period (in days), remove records whose due date or
// creation date exceeds the period.  This helps manage storage and reduces
// clutter.  A deletion audit log entry is recorded for each purged record.
function applyRetention() {
  const now = new Date();
  // Define how to determine a record date for each module.  For modules
  // without a due date or createdAt, fall back to id time.
  const modules = {
    actions: (rec) => rec.due || rec.createdAt || rec.id,
    complaints: (rec) => rec.dueDate || rec.createdAt || rec.id,
    audits: (rec) => rec.scheduleDate || rec.createdAt || rec.id,
    risks: (rec) => rec.due || rec.createdAt || rec.id,
    permits: (rec) => rec.due || rec.createdAt || rec.id,
    safety: (rec) => rec.date || rec.createdAt || rec.id,
    sds: (rec) => rec.date || rec.createdAt || rec.id,
    training: (rec) => rec.date || rec.createdAt || rec.id
  };
  Object.keys(modules).forEach(module => {
    const days = getRetention(module);
    if(!days || isNaN(days) || days <= 0) return;
    let list = getStore(module) || [];
    const getter = modules[module];
    const remaining = [];
    list.forEach(rec => {
      const recDateStr = getter(rec);
      const recDate = new Date(recDateStr);
      if(isNaN(recDate)){
        remaining.push(rec);
        return;
      }
      const diff = Math.floor((now - recDate) / (1000 * 60 * 60 * 24));
      if(diff > days){
        // Purge record and log
        addAuditLog('Retention Delete', 'Record auto-purged from module '+module, { entity: rec.id, before: rec, after: null, module });
      } else {
        remaining.push(rec);
      }
    });
    setStore(module, remaining);
  });
}

// Set of selected action IDs for bulk operations.  Entries are string IDs.
const selectedActions = new Set();

// =====================================================================
// Pending tasks rendering
//
// The home page displays a personalised list of pending tasks for the
// logged‑in user.  Initially this logic was executed only when the
// dashboard charts were present, which prevented the list from
// rendering on pages like index.html.  The function below encapsulates
// the task aggregation and rendering logic and is registered to run
// whenever the DOM has loaded.  It combines actions assigned to the
// current user and training sessions where the user is a participant.
function renderPendingTasks() {
  const tasksListEl = document.getElementById('myTasksList');
  if(!tasksListEl) return;
  const current = getCurrentUser();
  const aggregated = [];
  // Retrieve actions and filter by ownerId matching the current user
  let myActs = getStore('actions') || [];
  myActs = myActs.filter(a => {
    if(!a.ownerId || !current) return false;
    const allowed = [String(current.id)];
    if(current.employeeId) allowed.push(String(current.employeeId));
    const idPart = String(a.ownerId).replace(/^usr-|^emp-/, '');
    return a.status !== 'Verified Closed' && allowed.includes(String(idPart));
  });
  // Convert action tasks into a common format and mark type
  myActs.forEach(a => {
    aggregated.push(Object.assign({}, a, { type: 'action' }));
  });
  // Add training tasks for the current employee
  const sessions = getStore('training') || [];
  if(current && current.employeeId){
    sessions.forEach(sess => {
      let parts = [];
      if(Array.isArray(sess.participants)) parts = sess.participants;
      else if(sess.participants) parts = [sess.participants];
      const includes = parts.map(String).includes(String(current.employeeId));
      const status = (sess.status || '').toLowerCase();
      if(includes && status !== 'completed' && status !== 'cancelled'){
        aggregated.push({
          id: sess.id,
          title: sess.title || '(Training)',
          source: 'Training',
          due: sess.date || '',
          status: sess.status || '',
          type: 'training'
        });
      }
    });
  }
  // Sort tasks by due date (earliest first)
  aggregated.sort((a,b) => {
    const d1 = a.due ? new Date(a.due).getTime() : Infinity;
    const d2 = b.due ? new Date(b.due).getTime() : Infinity;
    return d1 - d2;
  });
  tasksListEl.innerHTML = '';
  if(aggregated.length === 0){
    const li = document.createElement('li');
    li.textContent = 'No pending tasks.';
    tasksListEl.appendChild(li);
  } else {
    aggregated.forEach(t => {
      const li = document.createElement('li');
      const due = t.due ? t.due : '-';
      li.innerHTML = `<b>${t.title}</b> (${t.source || 'Action'}) – Due: ${due} – Status: ${t.status || ''}`;
      // Only Action items have inline controls
      if(t.type === 'action'){
        const a = t;
        const btnWrap = document.createElement('div');
        btnWrap.style.marginTop = '4px';
        let editable = canEdit();
        if(!editable && current){
          const allowed = [String(current.id)];
          if(current.employeeId) allowed.push(String(current.employeeId));
          const idPart = String(a.ownerId || '').replace(/^usr-|^emp-/, '');
          editable = allowed.includes(idPart);
        }
        // Progress and completion controls for the owner
        if(editable){
          if(a.status === 'Open' || a.status === 'In Progress'){
            const progBtn = document.createElement('button');
            progBtn.textContent = 'Start/Progress';
            progBtn.onclick = () => {
              update(a.id, { status: 'In Progress' });
              window.location.reload();
            };
            btnWrap.appendChild(progBtn);
            const compBtn = document.createElement('button');
            compBtn.textContent = 'Mark Completed';
            compBtn.onclick = () => {
              const comment = prompt('Add comments (optional):', '') || '';
              update(a.id, { status: 'Pending Verification', qaEvidence: comment || 'Completed via dashboard' });
              window.location.reload();
            };
            btnWrap.appendChild(compBtn);
          }
        }
        // Verification control for QA roles only
        if(a.status === 'Pending Verification' && canVerify()){
          const inp = document.createElement('input');
          inp.placeholder = 'QA evidence note';
          inp.style.marginRight = '6px';
          const verBtn = document.createElement('button');
          verBtn.textContent = 'Verify & Close';
          verBtn.onclick = () => {
            update(a.id, { status: 'Verified Closed', qaEvidence: inp.value || 'Verified via dashboard' });
            window.location.reload();
          };
          btnWrap.appendChild(inp);
          btnWrap.appendChild(verBtn);
        }
        if(btnWrap.children.length > 0) li.appendChild(btnWrap);
      }
      tasksListEl.appendChild(li);
    });
  }
}

// Register rendering of pending tasks whenever any page loads.  The
// listener is attached at the top level so it fires on pages such as the
// home page (index.html) which do not contain the dashboard charts.  On
// pages where #myTasksList does not exist the function will simply
// return without doing anything.
document.addEventListener('DOMContentLoaded', renderPendingTasks);

// =====================================================================
// Global update helper
//
// Outside of the Action Management page we still need the ability to
// update action records (e.g. when progressing or verifying actions from
// the home page task list).  The function defined here mirrors the
// implementation used on the action page and is attached directly to
// the window so other modules can call it.  It persists updates to
// localStorage, records appropriate audit log entries, triggers backend
// synchronisation and re-renders the action board when applicable.
function update(id, patch){
  let actions = getStore('actions');
  const i = actions.findIndex(x => String(x.id) === String(id));
  if(i > -1){
    // Capture the record before applying updates for audit logging.
    const before = JSON.parse(JSON.stringify(actions[i]));
    const oldStatus = actions[i].status;
    // Apply patch to the existing record.
    actions[i] = { ...actions[i], ...patch };
    const after = JSON.parse(JSON.stringify(actions[i]));
    setStore('actions', actions);
    // Record a generic update audit entry capturing before/after state.
    addAuditLog('Update Action', 'Action ' + actions[i].title + ' updated', { entity: actions[i].id, before, after, module: 'Action Management' });
    // Log a separate status change entry if the status changed.
    if(patch.status && patch.status !== oldStatus){
      addAuditLog('Update Action Status', 'Action ' + actions[i].title + ' status changed to ' + patch.status, { entity: actions[i].id, module: 'Action Management' });
    }
    // Sync tasks to backend
    updateBackendTasks();
    // Re-render actions list when on actions page (renderActions may be undefined elsewhere)
    if(typeof renderActions === 'function'){
      renderActions();
    }
  }
}
// Expose update globally for other modules (e.g. dashboard controls)
window.update = update;

// Render the bulk operations panel on the Action Management page.  The panel
// allows users to change the status or owner of multiple selected actions
// at once, or delete them.  The panel is shown only when at least one
// action is selected.  When called the first time it constructs the panel
// DOM elements and attaches event handlers; subsequent calls simply update
// the selected count and visibility.
function renderBulkControls() {
  const pageContainer = document.querySelector('.container');
  if(!pageContainer) return;
  let panel = document.getElementById('bulkControls');
  if(!panel){
    panel = document.createElement('div');
    panel.id = 'bulkControls';
    panel.className = 'card';
    panel.style.marginTop = '1rem';
    panel.innerHTML = `
      <h3>Bulk Operations</h3>
      <p id="bulkCount"></p>
      <div class="grid-3">
        <div>
          <label>Change Status</label>
          <select id="bulkStatus">
            <option value="">--Select--</option>
            <option>Open</option>
            <option>In Progress</option>
            <option>Pending Verification</option>
            <option>Verified Closed</option>
          </select>
          <button id="bulkApplyStatus">Apply Status</button>
        </div>
        <div>
          <label>Assign Owner</label>
          <select id="bulkOwner"></select>
          <button id="bulkApplyOwner">Assign Owner</button>
        </div>
        <div>
          <button id="bulkDelete" style="background:#c73636">Delete Selected</button>
        </div>
      </div>
    `;
    // Insert the panel just after the form on the Action page
    const form = document.getElementById('actionForm');
    if(form && form.parentNode){
      form.parentNode.insertBefore(panel, form.nextSibling);
    } else {
      pageContainer.insertBefore(panel, pageContainer.firstChild);
    }
    // Populate owner select list with employees and users
    if(typeof populateAssigneeSelect === 'function'){
      populateAssigneeSelect('bulkOwner', true);
    }
    // Event: apply status to selected actions
    document.getElementById('bulkApplyStatus').addEventListener('click', ()=>{
      const newStatus = document.getElementById('bulkStatus').value;
      if(!newStatus) return;
      Array.from(selectedActions).forEach(id => {
        update(id, { status: newStatus });
      });
      // Clear selection after applying
      selectedActions.clear();
      renderBulkControls();
      // Rerender actions board after updates
      if(typeof renderActions === 'function') renderActions();
    });
    // Event: assign owner to selected actions
    document.getElementById('bulkApplyOwner').addEventListener('click', ()=>{
      const ownerVal = document.getElementById('bulkOwner').value;
      if(!ownerVal) return;
      Array.from(selectedActions).forEach(id => {
        let actions = getStore('actions');
        const idx = actions.findIndex(a => String(a.id) === String(id));
        if(idx > -1){
          let ownerId = ownerVal;
          let ownerName = '';
          let ownerEmail = '';
          if(ownerVal.startsWith('emp-')){
            const idPart = ownerVal.slice(4);
            const employees = getStore('employees') || [];
            const emp = employees.find(e => String(e.id) === String(idPart));
            if(emp){ ownerName = emp.name || ''; ownerEmail = emp.email || ''; }
          } else if(ownerVal.startsWith('usr-')){
            const idPart = ownerVal.slice(4);
            const users = getStore('users') || [];
            const user = users.find(u => String(u.id) === String(idPart));
            if(user){ ownerName = user.username + (user.role ? ' (' + user.role + ')' : ''); ownerEmail = user.email || ''; }
          }
          actions[idx].ownerId = ownerId;
          actions[idx].owner = ownerName || '';
          actions[idx].ownerEmail = ownerEmail || '';
        }
        setStore('actions', actions);
      });
      // Audit log for bulk assignment
      addAuditLog('Bulk Assign Owner', 'Bulk owner assignment applied to actions', { entity: Array.from(selectedActions), module: 'Action Management' });
      selectedActions.clear();
      renderBulkControls();
      if(typeof renderActions === 'function') renderActions();
    });
    // Event: bulk delete
    document.getElementById('bulkDelete').addEventListener('click', ()=>{
      if(!confirm('Delete selected actions?')) return;
      Array.from(selectedActions).forEach(id => {
        deleteAction(id);
      });
      selectedActions.clear();
      renderBulkControls();
      if(typeof renderActions === 'function') renderActions();
    });
  }
  // Update count and visibility
  const cnt = document.getElementById('bulkCount');
  if(cnt) cnt.textContent = selectedActions.size + ' selected';
  if(panel) panel.style.display = selectedActions.size > 0 ? 'block' : 'none';
}
// ====== Module definitions ======
// Define the modules available in the system.  Each module is represented
// by a key (matching the HTML file name without extension) and a label
// used in the user interface.  These definitions drive the role‑based
// permissions editor and navigation filtering.  If you add new module
// pages to the project, update this list accordingly.
const DEFAULT_MODULES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'complaints', label: 'Customer Complaints' },
  { key: 'actions', label: 'Action Management' },
  { key: 'audits', label: 'Internal Audits' },
  { key: 'mom', label: 'MOM' },
  { key: 'permits', label: 'Permit to Work' },
  { key: 'safety', label: 'Safety Issues' },
  { key: 'sds', label: 'SDS' },
  { key: 'training', label: 'Training' },
  { key: 'risk', label: 'Risk Register' },
  { key: 'equipment', label: 'Equipment & Calibration' },
  { key: 'change', label: 'Change Management' },
  { key: 'employees', label: 'Employees' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit_logs', label: 'Audit Logs' }
];

// Initialise role permissions for modules.  If no permissions are stored,
// every role is granted access to all modules by default.  The
// permissions are stored under the 'rolePermissions' key in
// localStorage as an object mapping role names to arrays of module
// labels.  Administrators can modify this mapping via the Role &
// Permissions editor in the Settings page.  When roles are added or
// removed, this helper ensures the permission structure remains in sync.
function initRolePermissions() {
  let perms;
  try {
    perms = JSON.parse(localStorage.getItem('rolePermissions') || '{}');
    if (typeof perms !== 'object' || perms === null) perms = {};
  } catch (e) {
    perms = {};
  }
  // Load roles list
  let roles;
  try {
    roles = JSON.parse(localStorage.getItem('roles') || '[]');
    if (!Array.isArray(roles) || roles.length === 0) {
      roles = DEFAULT_ROLES;
      localStorage.setItem('roles', JSON.stringify(roles));
    }
  } catch (e) {
    roles = DEFAULT_ROLES;
    localStorage.setItem('roles', JSON.stringify(roles));
  }
  // For each role ensure there is a permission entry; default to all modules
  let changed = false;
  roles.forEach(r => {
    if (!perms[r]) {
      perms[r] = DEFAULT_MODULES.map(m => m.label);
      changed = true;
    }
  });
  // Remove permissions for roles no longer present
  Object.keys(perms).forEach(r => {
    if (!roles.includes(r)) {
      delete perms[r];
      changed = true;
    }
  });
  if (changed) {
    localStorage.setItem('rolePermissions', JSON.stringify(perms));
  }
}

// Render the Role & Permissions editor.  This UI allows administrators to
// assign module access to each role via checkboxes.  The table lists
// roles down the left and modules across the top.  Ticking a box grants
// access; unticking revokes access.  Changes persist immediately.
function renderRolePermissions() {
  const container = document.getElementById('rolePermissionSettings');
  if (!container) return;
  initRolePermissions();
  // Fetch roles and current permission mapping
  let roles;
  try {
    roles = JSON.parse(localStorage.getItem('roles') || '[]');
    if (!Array.isArray(roles) || roles.length === 0) {
      roles = DEFAULT_ROLES;
      localStorage.setItem('roles', JSON.stringify(roles));
    }
  } catch (e) {
    roles = DEFAULT_ROLES;
    localStorage.setItem('roles', JSON.stringify(roles));
  }
  let perms;
  try {
    perms = JSON.parse(localStorage.getItem('rolePermissions') || '{}');
    if (typeof perms !== 'object' || perms === null) perms = {};
  } catch (e) {
    perms = {};
  }
  // Ensure each role has an entry
  roles.forEach(r => {
    if (!perms[r]) perms[r] = DEFAULT_MODULES.map(m => m.label);
  });
  // Build table
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'permission-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  DEFAULT_MODULES.forEach(mod => {
    const th = document.createElement('th');
    th.textContent = mod.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  roles.forEach(role => {
    const row = document.createElement('tr');
    const roleCell = document.createElement('td');
    roleCell.textContent = role;
    row.appendChild(roleCell);
    DEFAULT_MODULES.forEach(mod => {
      const cell = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Array.isArray(perms[role]) && perms[role].includes(mod.label);
      cb.addEventListener('change', () => {
        let map;
        try {
          map = JSON.parse(localStorage.getItem('rolePermissions') || '{}');
          if (typeof map !== 'object' || map === null) map = {};
        } catch (e) {
          map = {};
        }
        if (!Array.isArray(map[role])) map[role] = [];
        if (cb.checked) {
          if (!map[role].includes(mod.label)) map[role].push(mod.label);
        } else {
          map[role] = map[role].filter(l => l !== mod.label);
        }
        localStorage.setItem('rolePermissions', JSON.stringify(map));
      });
      cell.appendChild(cb);
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

// Apply module permissions to the navigation bar.  This helper hides
// navigation links to modules that the current user's role does not
// have permission to access.  Admin users always retain full access.
function applyRolePermissions() {
  const current = getCurrentUser();
  if (!current || !current.role) return;
  // Do not restrict admins
  if (current.role === 'admin') return;
  let perms;
  try {
    perms = JSON.parse(localStorage.getItem('rolePermissions') || '{}');
    if (typeof perms !== 'object' || perms === null) perms = {};
  } catch (e) {
    perms = {};
  }
  const allowed = perms[current.role] || [];
  // Hide nav items that are not allowed
  const navLinks = document.querySelectorAll('.navbar a[href]');
  navLinks.forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href === '#' || href === 'login.html') return;
    // extract filename without extension
    const file = href.split('?')[0].replace(/\.html$/, '');
    // map file to module label using DEFAULT_MODULES
    const mod = DEFAULT_MODULES.find(m => m.key === file);
    if (mod && !allowed.includes(mod.label)) {
      a.style.display = 'none';
    }
  });
}

// ====== User authentication and role management ======
// Initialise default users if none exist. We store users in localStorage under
// the key 'users'. Each user has id, username, password (base64-encoded), and
// role. A default admin (admin/admin123) and regular user (user/user123) are
// created on first run. Passwords are encoded for demonstration only; this is
// **not** secure and should be replaced with proper hashing in production.
function initUsers(){
  if(!localStorage.getItem('users')){
    const users = [
      {
        id: uid(),
        username: 'admin',
        password: btoa('admin123'),
        role: 'admin',
        email: '',
        // track whether the account is active; admins can disable accounts
        active: true,
        // last login timestamp; updated upon successful login
        lastLogin: ''
      },
      {
        id: uid(),
        username: 'user',
        password: btoa('user123'),
        role: 'user',
        email: '',
        active: true,
        lastLogin: ''
      }
    ];
    setStore('users', users);
  }
  // Migrate existing users to include active and lastLogin properties
  try {
    let existing = getStore('users');
    let changed = false;
    existing.forEach(u => {
      if (u.active === undefined) {
        u.active = true;
        changed = true;
      }
      if (u.lastLogin === undefined) {
        u.lastLogin = '';
        changed = true;
      }
      if (u.email === undefined) {
        u.email = '';
        changed = true;
      }
    });
    if (changed) {
      setStore('users', existing);
    }
  } catch (e) {
    // ignore errors
  }
  // Ensure there's always a currentUser entry; leave empty by default
  if(!localStorage.getItem('currentUser')){
    localStorage.setItem('currentUser', '{}');
  }
}

// Retrieve currently logged-in user
function getCurrentUser(){ return JSON.parse(localStorage.getItem('currentUser')||'{}'); }

// Return true if a user is logged in
function isLoggedIn(){ const u = getCurrentUser(); return u && u.username; }

// Return true if current user has admin role
function isAdmin(){ const u = getCurrentUser(); return u && u.role === 'admin'; }

// Perform login: check username/password against stored users. On success
// save the user (without password) to localStorage under 'currentUser' and
// redirect to dashboard. On failure show error.
function loginUser(usernameOrEmail, password){
  const users = getStore('users');
  // allow login via username or email, case-insensitive
  const user = users.find(u => {
    const uname = (u.username || '').toLowerCase();
    const mail = (u.email || '').toLowerCase();
    const credential = (usernameOrEmail || '').toLowerCase();
    return uname === credential || mail === credential;
  });
  const errEl = document.getElementById('loginError');
  if (!user || atob(user.password) !== password) {
    if (errEl) errEl.textContent = 'Invalid username/email or password.';
    return;
  }
  // Check if the account is active
  if (user.active === false) {
    if (errEl) errEl.textContent = 'Account is inactive. Please contact an administrator.';
    return;
  }
  // Update last login timestamp for the user record
  const idx = users.findIndex(u => u.id === user.id);
  if (idx > -1) {
    users[idx].lastLogin = new Date().toISOString();
    // If user is not linked to an employee but has an email, try to link by matching employee email
    if(!users[idx].employeeId || users[idx].employeeId === ''){
      const emps = getStore('employees') || [];
      if(user.email){
        const matchEmp = emps.find(e => (e.email || '').toLowerCase() === user.email.toLowerCase());
        if(matchEmp){
          users[idx].employeeId = matchEmp.id;
          user.employeeId = matchEmp.id;
        }
      }
    }
    setStore('users', users);
  }
  // Persist current user information, including linked employeeId if present
  localStorage.setItem('currentUser', JSON.stringify({ id: user.id, username: user.username, role: user.role, employeeId: user.employeeId || '' }));
  // redirect to dashboard
  window.location = 'index.html';
}

// Log the user out and redirect to login page
function logoutUser(){
  localStorage.setItem('currentUser', '{}');
  window.location = 'login.html';
}

// Require a user to be logged in. If not logged in, redirect to login page.
function requireLogin(){
  if(!isLoggedIn()){
    window.location = 'login.html';
  }
}

// User deletion helper (admin only). When deleting the currently logged in
// account, automatically log out.
function deleteUser(id){
  let users = getStore('users');
  const user = users.find(u=>String(u.id)===String(id));
  if(!user) return;
  if(!confirm('Delete user '+user.username+'?')) return;
  users = users.filter(u=>String(u.id)!==String(id));
  setStore('users', users);
  // Record audit log
  addAuditLog('Delete User', 'User ' + user.username + ' deleted');
  // If the deleted user is currently logged in, log them out
  const current = getCurrentUser();
  if(current && String(current.id) === String(id)){
    logoutUser();
  } else {
    renderUsers();
  }
}

// Render the users list in settings page
function renderUsers(){
  const table = document.getElementById('userTable');
  if(!table) return;
  // Remove existing rows except header
  while(table.rows.length > 1){ table.deleteRow(1); }
  const users = getStore('users');
  users.forEach(u => {
    const tr = table.insertRow();
    // Username
    tr.insertCell(0).innerText = u.username;
    // Email
    tr.insertCell(1).innerText = u.email || '';
    // Role
    tr.insertCell(2).innerText = u.role;
    // Last login (formatted)
    const last = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '-';
    tr.insertCell(3).innerText = last;
    // Active status
    tr.insertCell(4).innerText = u.active ? 'Active' : 'Inactive';
    // Actions cell
    const actions = tr.insertCell(5);
    // Toggle active/inactive button
    const toggle = document.createElement('button');
    toggle.textContent = u.active ? 'Deactivate' : 'Activate';
    toggle.style.marginRight = '8px';
    toggle.onclick = () => {
      let usersList = getStore('users');
      const idx = usersList.findIndex(x => String(x.id) === String(u.id));
      if (idx > -1) {
        usersList[idx].active = !usersList[idx].active;
        setStore('users', usersList);
        // Record audit log
        addAuditLog(usersList[idx].active ? 'Activate User' : 'Deactivate User', 'User ' + u.username + ' ' + (usersList[idx].active ? 'activated' : 'deactivated'));
        renderUsers();
      }
    };
    actions.appendChild(toggle);
    // Reset password button for admin convenience
    const reset = document.createElement('button');
    reset.textContent = 'Reset PW';
    reset.style.marginRight = '8px';
    reset.onclick = () => {
      const newPass = prompt('Enter new password for ' + u.username + ':');
      if (newPass) {
        let usersList = getStore('users');
        const idx = usersList.findIndex(x => String(x.id) === String(u.id));
        if (idx > -1) {
          usersList[idx].password = btoa(newPass);
          setStore('users', usersList);
          alert('Password updated for ' + u.username);
          // Record audit log
          addAuditLog('Reset Password', 'Password for user ' + u.username + ' reset');
        }
      }
    };
    actions.appendChild(reset);
    // Delete button
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.style.background = '#c73636';
    del.onclick = () => deleteUser(u.id);
    actions.appendChild(del);
  });
}

// Default statuses for various modules. When status settings are first opened,
// these defaults will be written to localStorage if the keys don't already
// exist. Admins can add or remove values in the settings page.
const DEFAULT_STATUSES = {
  complaintStatuses: ["New","In Review","Under Investigation","Actioning","Verifying","Closed"],
  actionStatuses: ["Open","In Progress","Pending Verification","Verified Closed"],
  auditStatuses: ["Planned","In Progress","Completed"],
  momStatuses: ["Scheduled","Completed"],
  permitStatuses: ["Requested","Approved","In Progress","Closed"],
  safetyStatuses: ["New","Investigating","Actioning","Closed"],
  sdsStatuses: ["Valid","Pending Revision","Expired"],
  trainingStatuses: ["Scheduled","Completed","Overdue"]
  ,
  // Equipment statuses to track assets through their maintenance lifecycle
  equipmentStatuses: ["Active","Maintenance Due","Calibration Due","Out of Service"],
  // Change management statuses covering the typical workflow of a change request
  changeStatuses: ["Requested","Under Review","Approved","Implemented","Rejected"],
  // Risk statuses define the life cycle of a risk record.  Risks typically move from
  // being identified through review and mitigation before closure.
  riskStatuses: ["Identified","In Review","Mitigating","Closed"]
};

// Default categories for hazard types and training categories
const DEFAULT_CATEGORIES = {
  hazardTypes: ["Fire","Chemical","Electrical","Slip & Trip","Other"],
  trainingCategories: ["Safety","Quality","Equipment","Other"]
  ,
  // Risk categories are used by the Risk Register module.  Administrators can
  // configure these in the Settings page to align with organisational risk
  // classifications.
  riskCategories: ["Operational","Environmental","Health & Safety","Financial","Other"]
};

// Default employee roles and their associated training category requirements.  Each
// role maps to an array of training categories that employees must complete.
// Administrators can modify roles and role requirements in the Settings page.
const DEFAULT_ROLES = [
  "Hydro Jetter",
  "Welder",
  "Electrician",
  "Mechanic",
  "Inspector",
  // Additional roles for office and workshop functions. These can be
  // modified via the Settings page to fit your organisational structure.
  "Maintenance",
  "Operations",
  "Dispatch",
  // Break down office roles into specific departments
  "HR",
  "Purchasing",
  "Finance",
  "Internal Auditor",
  "OP-ICS",
  "OP-WDS",
  "Business Development",
  "QSHE"
];
const DEFAULT_ROLE_REQUIREMENTS = {
  "Hydro Jetter": ["Safety","Equipment"],
  "Welder": ["Safety","Quality"],
  "Electrician": ["Safety","Equipment"],
  "Mechanic": ["Safety","Equipment"],
  "Inspector": ["Safety","Quality"]
};

// Roles that are permitted to edit or manage records across the system.
// The built‑in 'admin' role is always allowed. Administrators can
// modify this list from the Settings page by updating the `editRoles`
// value in localStorage. Additional roles placed here will be able to
// see and edit all records, not just their own assignments.
const DEFAULT_EDIT_ROLES = ["admin"];

// Roles that are part of the Quality Assurance (QA) group.  Only users
// with these roles (or admins) may perform QA verification of actions.
// Administrators can configure this list via the Settings page.  By
// default the list is empty – no additional roles have QA privileges
// until configured.  The built‑in admin role always has QA rights.
const DEFAULT_QA_ROLES = [];

// Initialise the qaRoles list if it hasn't been configured yet.  If
// the 'qaRoles' key is missing or contains invalid data in
// localStorage, it is populated with DEFAULT_QA_ROLES.  This helper is
// idempotent and can be called multiple times.
function initQaRoles() {
  try {
    let roles = JSON.parse(localStorage.getItem('qaRoles') || '[]');
    if (!Array.isArray(roles)) {
      localStorage.setItem('qaRoles', JSON.stringify(DEFAULT_QA_ROLES));
    }
  } catch (e) {
    localStorage.setItem('qaRoles', JSON.stringify(DEFAULT_QA_ROLES));
  }
}

// Determine if the currently logged in user has QA verification
// privileges.  Returns true for admins and any user whose role is
// included in the qaRoles array stored in localStorage.  Users with
// QA privileges can verify actions that are pending verification,
// regardless of whether they are the owner or have edit rights.
function canVerify() {
  const current = getCurrentUser();
  if (!current || !current.role) return false;
  if (current.role === 'admin') return true;
  try {
    const roles = JSON.parse(localStorage.getItem('qaRoles') || '[]');
    return Array.isArray(roles) && roles.includes(current.role);
  } catch (e) {
    return false;
  }
}

// Render the roles that are part of the QA verification group.  This
// function displays a list of all roles with checkboxes.  When
// selected, the role is added to the qaRoles list in localStorage.
function renderQaRoles() {
  const container = document.getElementById('qaRoleSettings');
  if (!container) return;
  // Ensure qaRoles is initialised
  initQaRoles();
  let qaRoles = [];
  try {
    qaRoles = JSON.parse(localStorage.getItem('qaRoles') || '[]');
    if (!Array.isArray(qaRoles)) qaRoles = [];
  } catch (e) {
    qaRoles = [];
  }
  // Load available roles from storage or defaults
  let roles = [];
  try {
    roles = JSON.parse(localStorage.getItem('roles') || '[]');
    if (!Array.isArray(roles) || roles.length === 0) {
      roles = DEFAULT_ROLES;
      localStorage.setItem('roles', JSON.stringify(roles));
    }
  } catch (e) {
    roles = DEFAULT_ROLES;
    localStorage.setItem('roles', JSON.stringify(roles));
  }
  // Clear existing contents
  container.innerHTML = '';
  const info = document.createElement('p');
  info.className = 'small-text';
  info.textContent = 'Tick the roles that should be part of the QA group. Users with these roles may verify actions.';
  container.appendChild(info);
  roles.forEach(r => {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '4px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'qaRole_' + r;
    cb.value = r;
    cb.checked = qaRoles.includes(r);
    cb.onchange = () => {
      let currentList = [];
      try {
        currentList = JSON.parse(localStorage.getItem('qaRoles') || '[]');
        if (!Array.isArray(currentList)) currentList = [];
      } catch (err) {
        currentList = [];
      }
      if (cb.checked) {
        if (!currentList.includes(r)) currentList.push(r);
      } else {
        currentList = currentList.filter(x => x !== r);
      }
      localStorage.setItem('qaRoles', JSON.stringify(currentList));
    };
    const label = document.createElement('label');
    label.setAttribute('for', cb.id);
    label.style.marginLeft = '4px';
    label.textContent = r;
    wrapper.appendChild(cb);
    wrapper.appendChild(label);
    container.appendChild(wrapper);
  });
}

// Initialise the editRoles list if it hasn't been configured yet.
// If the 'editRoles' key is missing or empty in localStorage, it is
// populated with DEFAULT_EDIT_ROLES.  This helper is idempotent and
// may be called multiple times without side effects.
function initEditRoles() {
  try {
    let roles = JSON.parse(localStorage.getItem('editRoles') || '[]');
    if (!Array.isArray(roles) || roles.length === 0) {
      localStorage.setItem('editRoles', JSON.stringify(DEFAULT_EDIT_ROLES));
    }
  } catch (e) {
    localStorage.setItem('editRoles', JSON.stringify(DEFAULT_EDIT_ROLES));
  }
}

// Determine if the currently logged in user is authorised to modify data.
// Returns true for admins and any user whose role is included in the
// editRoles array stored in localStorage. Non‑authorised users will
// only see their own assigned tasks and will have limited edit controls.
function canEdit() {
  const current = getCurrentUser();
  if (!current || !current.role) return false;
  if (current.role === 'admin') return true;
  try {
    const roles = JSON.parse(localStorage.getItem('editRoles') || '[]');
    return Array.isArray(roles) && roles.includes(current.role);
  } catch (e) {
    return false;
  }
}

// ===== Risk Module Helpers =====
// Delete a risk record by id and log the operation.
function deleteRisk(id) {
  let risks = getStore('risks') || [];
  risks = risks.filter(r => String(r.id) !== String(id));
  setStore('risks', risks);
  // Record audit log entry for deletions
  addAuditLog('Delete Risk', 'Risk ' + id + ' deleted');
}

// Save updated status for a risk record from the detail page.  This helper
// updates the status and records a history entry.  It is invoked from
// risk_detail.html via the onclick handler on the Save button.  It
// persists changes and refreshes the page to reflect updates.
function saveRiskStatus() {
  const sel = document.getElementById('riskStatusSelect');
  if (!sel) return;
  const newStatus = sel.value;
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get('id');
  let risks = getStore('risks') || [];
  const idx = risks.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return;
  const risk = risks[idx];
  if (risk.status !== newStatus) {
    risk.status = newStatus;
    risk.history = risk.history || [];
    risk.history.push('Status changed to ' + newStatus + ' on ' + new Date().toLocaleString());
    setStore('risks', risks);
    addAuditLog('Update Risk Status', 'Risk ' + (risk.no || risk.id) + ' set to ' + newStatus);
    // Refresh to update UI
    location.reload();
  }
}

// Default list of training courses. Each course has a title and associated
// training category. Administrators can manage courses in the Settings page.
const DEFAULT_COURSES = [
  { title: 'Hydro Jet Safety', category: 'Safety' },
  { title: 'Confined Space Entry', category: 'Safety' },
  { title: 'Hazardous Waste Handling', category: 'Safety' },
  { title: 'Welding Safety', category: 'Safety' },
  { title: 'Electrical Equipment Maintenance', category: 'Equipment' },
  { title: 'Quality Management Basics', category: 'Quality' }
];

// Default mapping of roles to specific training course titles. This mapping
// allows organisations to require certain courses for a given role. Admins
// can modify these in the Settings page.
const DEFAULT_ROLE_COURSE_REQS = {
  'Hydro Jetter': ['Hydro Jet Safety','Confined Space Entry','Hazardous Waste Handling'],
  'Welder': ['Welding Safety','Quality Management Basics'],
  'Electrician': ['Electrical Equipment Maintenance','Safety'],
  'Mechanic': ['Electrical Equipment Maintenance'],
  'Inspector': ['Quality Management Basics']
};

// Render the courses management UI. Allows adding and removing course
// definitions. Each course has a title and category. Courses are stored in
// localStorage under the key 'courses'.
function renderCourses(){
  const container = document.getElementById('courseSettings');
  if(!container) return;
  let courses = JSON.parse(localStorage.getItem('courses') || '[]');
  if(!courses || courses.length === 0){
    courses = DEFAULT_COURSES;
    localStorage.setItem('courses', JSON.stringify(courses));
  }
  // Ensure categories list exists for categories select
  let cats = JSON.parse(localStorage.getItem('trainingCategories') || '[]');
  if(!cats || cats.length === 0){ cats = DEFAULT_CATEGORIES.trainingCategories; localStorage.setItem('trainingCategories', JSON.stringify(cats)); }
  container.innerHTML = '';
  // List courses
  const table = document.createElement('table');
  const thead = document.createElement('tr');
  thead.innerHTML = '<th>Title</th><th>Category</th><th>Delete</th>';
  table.appendChild(thead);
  courses.forEach((c, idx) => {
    const tr = document.createElement('tr');
    tr.insertCell(0).innerText = c.title;
    tr.insertCell(1).innerText = c.category;
    const delCell = tr.insertCell(2);
    const delBtn = document.createElement('button');
    delBtn.textContent = 'x';
    delBtn.style.background = '#c73636';
    delBtn.onclick = () => {
      let list = JSON.parse(localStorage.getItem('courses') || '[]');
      list.splice(idx, 1);
      localStorage.setItem('courses', JSON.stringify(list));
      renderCourses();
      renderRoleCourses();
    };
    delCell.appendChild(delBtn);
    table.appendChild(tr);
  });
  container.appendChild(table);
  // Add course form
  const form = document.createElement('form');
  form.className = 'inline-form';
  form.onsubmit = (e) => {
    e.preventDefault();
    const title = form.querySelector('input[name="courseTitle"]').value.trim();
    const cat = form.querySelector('select[name="courseCategory"]').value;
    if(!title) return;
    let list = JSON.parse(localStorage.getItem('courses') || '[]');
    // prevent duplicates by title
    if(list.some(c => c.title === title)){
      alert('Course already exists');
      return;
    }
    list.push({ title, category: cat });
    localStorage.setItem('courses', JSON.stringify(list));
    form.reset();
    renderCourses();
    renderRoleCourses();
  };
  // Course title input
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.name = 'courseTitle';
  titleInput.placeholder = 'Course title';
  titleInput.required = true;
  form.appendChild(titleInput);
  // Category select
  const catSel = document.createElement('select');
  catSel.name = 'courseCategory';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catSel.appendChild(opt);
  });
  form.appendChild(catSel);
  // Add button
  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.textContent = 'Add Course';
  form.appendChild(addBtn);
  container.appendChild(form);
}

// Render the role-course requirement UI. Displays a list of roles with
// checkboxes for each training course. Checking/unchecking courses updates
// the roleCourseRequirements mapping stored in localStorage. Similar to
// renderRoleTraining but works with individual courses.
function renderRoleCourses(){
  const container = document.getElementById('roleCourseSettings');
  if(!container) return;
  // Fetch roles
  let roles = JSON.parse(localStorage.getItem('roles') || '[]');
  if(!roles || roles.length === 0){ roles = DEFAULT_ROLES; localStorage.setItem('roles', JSON.stringify(roles)); }
  // Fetch courses
  let courses = JSON.parse(localStorage.getItem('courses') || '[]');
  if(!courses || courses.length === 0){ courses = DEFAULT_COURSES; localStorage.setItem('courses', JSON.stringify(courses)); }
  // Role-course mapping
  let mapping = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
  // Initialise mapping with defaults if empty
  if(Object.keys(mapping).length === 0){ mapping = Object.assign({}, DEFAULT_ROLE_COURSE_REQS); localStorage.setItem('roleCourseRequirements', JSON.stringify(mapping)); }
  container.innerHTML = '';
  roles.forEach(role => {
    const row = document.createElement('div');
    row.className = 'role-training-row';
    const roleLabel = document.createElement('strong');
    roleLabel.textContent = role;
    row.appendChild(roleLabel);
    courses.forEach(course => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = role + '-' + course.title;
      cb.style.marginLeft = '12px';
      cb.checked = Array.isArray(mapping[role]) && mapping[role].includes(course.title);
      cb.addEventListener('change', () => {
        let map = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
        if(!Array.isArray(map[role])) map[role] = [];
        if(cb.checked){
          if(!map[role].includes(course.title)) map[role].push(course.title);
        } else {
          map[role] = map[role].filter(c => c !== course.title);
        }
        localStorage.setItem('roleCourseRequirements', JSON.stringify(map));
      });
      const lbl = document.createElement('label');
      lbl.setAttribute('for', cb.id);
      lbl.textContent = course.title;
      lbl.style.marginRight = '8px';
      row.appendChild(cb);
      row.appendChild(lbl);
    });
    container.appendChild(row);
  });
}

// Render the roles that have system‑wide editing privileges.  Administrators
// can select which roles (beyond the built‑in admin) are allowed to view
// and modify all records.  The list of available roles is loaded from
// localStorage or defaults.  A checkbox is displayed for each role; when
// toggled, the selected roles are persisted under the `editRoles` key in
// localStorage.  This helper ensures that the editRoles array always
// contains only valid roles.
function renderEditRoles() {
  const container = document.getElementById('editRoleSettings');
  if (!container) return;
  // Ensure editRoles is initialised
  initEditRoles();
  let editRoles = [];
  try {
    editRoles = JSON.parse(localStorage.getItem('editRoles') || '[]');
    if (!Array.isArray(editRoles)) editRoles = [];
  } catch (e) {
    editRoles = [];
  }
  // Load roles for checkboxes
  let roles = [];
  try {
    roles = JSON.parse(localStorage.getItem('roles') || '[]');
    if (!Array.isArray(roles) || roles.length === 0) {
      roles = DEFAULT_ROLES;
      localStorage.setItem('roles', JSON.stringify(roles));
    }
  } catch (e) {
    roles = DEFAULT_ROLES;
    localStorage.setItem('roles', JSON.stringify(roles));
  }
  // Clear existing contents
  container.innerHTML = '';
  // Show a note
  const info = document.createElement('p');
  info.className = 'small-text';
  info.textContent = 'Tick the roles that should have editing permissions. Users with these roles will be able to access all records and settings.';
  container.appendChild(info);
  roles.forEach(r => {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '4px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'editRole_' + r;
    cb.value = r;
    cb.checked = editRoles.includes(r);
    cb.onchange = () => {
      let current = [];
      try {
        current = JSON.parse(localStorage.getItem('editRoles') || '[]');
        if (!Array.isArray(current)) current = [];
      } catch (err) {
        current = [];
      }
      if (cb.checked) {
        if (!current.includes(r)) current.push(r);
      } else {
        current = current.filter(x => x !== r);
      }
      localStorage.setItem('editRoles', JSON.stringify(current));
    };
    const label = document.createElement('label');
    label.setAttribute('for', cb.id);
    label.style.marginLeft = '4px';
    label.textContent = r;
    wrapper.appendChild(cb);
    wrapper.appendChild(label);
    container.appendChild(wrapper);
  });
}

// Render the roles list management UI in Settings. Allows adding and
// removing roles. Roles are stored in localStorage under the key 'roles'.
function renderRoles(){
  const container = document.getElementById('roleSettings');
  if(!container) return;
  // Fetch existing roles or initialise from defaults
  let roles = JSON.parse(localStorage.getItem('roles') || '[]');
  if(!roles || roles.length === 0){ roles = DEFAULT_ROLES; localStorage.setItem('roles', JSON.stringify(roles)); }
  container.innerHTML = '';
  // List current roles
  const ul = document.createElement('ul');
  roles.forEach((role, idx) => {
    const li = document.createElement('li');
    li.textContent = role;
    // Delete button – removes the role and cleans up associated data
    const del = document.createElement('button');
    del.textContent = 'x';
    del.style.marginLeft = '8px';
    del.style.background = '#c73636';
    del.onclick = () => {
      let list = JSON.parse(localStorage.getItem('roles') || '[]');
      // Remove the role at the current index and persist list
      const removed = list.splice(idx, 1)[0];
      localStorage.setItem('roles', JSON.stringify(list));
      // Remove training category and course mappings for this role
      let reqMap = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
      delete reqMap[removed];
      localStorage.setItem('roleRequirements', JSON.stringify(reqMap));
      let courseMap = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
      delete courseMap[removed];
      localStorage.setItem('roleCourseRequirements', JSON.stringify(courseMap));
      // Remove the role from editRoles if present
      let editors = JSON.parse(localStorage.getItem('editRoles') || '[]');
      editors = editors.filter(r => r !== removed);
      localStorage.setItem('editRoles', JSON.stringify(editors));
      // Update employees with this role to have no role
      let employees = JSON.parse(localStorage.getItem('employees') || '[]');
      employees = employees.map(emp => {
        if(emp.role === removed){
          return Object.assign({}, emp, { role: '' });
        }
        return emp;
      });
      localStorage.setItem('employees', JSON.stringify(employees));
      renderRoles();
      renderRoleTraining();
      renderRoleCourses();
      renderEditRoles();
    };
    li.appendChild(del);
    // Edit button – allows renaming of a role while preserving mappings and user assignments
    const editBtn = document.createElement('button');
    editBtn.textContent = 'edit';
    editBtn.style.marginLeft = '4px';
    editBtn.onclick = () => {
      const newName = prompt('Rename role:', role);
      if(newName && newName.trim() !== '' && newName !== role){
        const trimmed = newName.trim();
        let rolesList = JSON.parse(localStorage.getItem('roles') || '[]');
        if(!rolesList.includes(trimmed)){
          rolesList[idx] = trimmed;
          localStorage.setItem('roles', JSON.stringify(rolesList));
          // Update training requirement mappings
          let req = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
          if(req[role]){
            req[trimmed] = req[role];
            delete req[role];
            localStorage.setItem('roleRequirements', JSON.stringify(req));
          }
          let course = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
          if(course[role]){
            course[trimmed] = course[role];
            delete course[role];
            localStorage.setItem('roleCourseRequirements', JSON.stringify(course));
          }
          // Update editRoles list
          let edits = JSON.parse(localStorage.getItem('editRoles') || '[]');
          const pos = edits.indexOf(role);
          if(pos !== -1){ edits[pos] = trimmed; localStorage.setItem('editRoles', JSON.stringify(edits)); }
          // Update employees assigned to this role
          let emps = JSON.parse(localStorage.getItem('employees') || '[]');
          emps = emps.map(emp => {
            if(emp.role === role) return Object.assign({}, emp, { role: trimmed });
            return emp;
          });
          localStorage.setItem('employees', JSON.stringify(emps));
          renderRoles();
          renderRoleTraining();
          renderRoleCourses();
          renderEditRoles();
        } else {
          alert('Role name already exists.');
        }
      }
    };
    li.appendChild(editBtn);
    ul.appendChild(li);
  });
  container.appendChild(ul);
  // Input to add a new role
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'New role';
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.onclick = () => {
    const val = input.value.trim();
    if(val){
      let list = JSON.parse(localStorage.getItem('roles') || '[]');
      if(!list.includes(val)){
        list.push(val);
        localStorage.setItem('roles', JSON.stringify(list));
        // If there is no mapping for this role yet, create an empty mapping
        let mapping = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
        if(!mapping[val]) mapping[val] = [];
        localStorage.setItem('roleRequirements', JSON.stringify(mapping));
        renderRoles();
        renderRoleTraining();
      }
      input.value = '';
    }
  };
  container.appendChild(input);
  container.appendChild(addBtn);
}

// Render the role training requirements UI in Settings. Displays a list of
// roles with checkboxes for each training category. Checking or unchecking
// categories updates the roleRequirements mapping in localStorage.
function renderRoleTraining(){
  const container = document.getElementById('roleTrainingSettings');
  if(!container) return;
  // Ensure roles and training categories are initialised
  let roles = JSON.parse(localStorage.getItem('roles') || '[]');
  if(!roles || roles.length === 0){ roles = DEFAULT_ROLES; localStorage.setItem('roles', JSON.stringify(roles)); }
  // Training categories
  let categories = JSON.parse(localStorage.getItem('trainingCategories') || '[]');
  if(!categories || categories.length === 0){ categories = DEFAULT_CATEGORIES.trainingCategories; localStorage.setItem('trainingCategories', JSON.stringify(categories)); }
  // Role requirements mapping
  let mapping = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
  // If mapping is empty, initialise with defaults
  if(Object.keys(mapping).length === 0){
    mapping = Object.assign({}, DEFAULT_ROLE_REQUIREMENTS);
    localStorage.setItem('roleRequirements', JSON.stringify(mapping));
  }
  container.innerHTML = '';
  roles.forEach(role => {
    const row = document.createElement('div');
    row.className = 'role-training-row';
    const roleLabel = document.createElement('strong');
    roleLabel.textContent = role;
    row.appendChild(roleLabel);
    categories.forEach(cat => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = role + '-' + cat;
      cb.style.marginLeft = '12px';
      // Determine if this role has this category assigned
      cb.checked = Array.isArray(mapping[role]) && mapping[role].includes(cat);
      cb.addEventListener('change', () => {
        let map = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
        if(!Array.isArray(map[role])) map[role] = [];
        if(cb.checked){
          if(!map[role].includes(cat)) map[role].push(cat);
        } else {
          map[role] = map[role].filter(c => c !== cat);
        }
        localStorage.setItem('roleRequirements', JSON.stringify(map));
      });
      const lbl = document.createElement('label');
      lbl.setAttribute('for', cb.id);
      lbl.textContent = cat;
      lbl.style.marginRight = '8px';
      row.appendChild(cb);
      row.appendChild(lbl);
    });
    container.appendChild(row);
  });
}

// Populate a select element with employee roles. If no roles exist, load
// defaults. Accepts either a DOM element or its id.
function populateRoleSelect(select){
  let sel = select;
  if(!sel) return;
  if(typeof select === 'string'){ sel = document.getElementById(select); }
  if(!sel) return;
  // Fetch roles from storage or default
  let roles = JSON.parse(localStorage.getItem('roles') || '[]');
  if(!roles || roles.length === 0){ roles = DEFAULT_ROLES; localStorage.setItem('roles', JSON.stringify(roles)); }
  sel.innerHTML = '';
  // Option for none / unassigned
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '';
  sel.appendChild(emptyOpt);
  roles.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  });
}

// Render status management UI in settings page
function renderStatuses(){
  const container = document.getElementById('statusSettings');
  if(!container) return;
  container.innerHTML = '';
  Object.keys(DEFAULT_STATUSES).forEach(key=>{
    let vals = JSON.parse(localStorage.getItem(key) || '[]');
    if(!vals || vals.length === 0){ vals = DEFAULT_STATUSES[key]; localStorage.setItem(key, JSON.stringify(vals)); }
    // Create section
    const section = document.createElement('div');
    section.className = 'status-section';
    // Title based on key
    const title = key.replace('Statuses','').replace(/([A-Z])/g, ' $1').trim();
    const heading = document.createElement('h3'); heading.textContent = title + ' Statuses';
    section.appendChild(heading);
    // List of statuses
    const ul = document.createElement('ul');
    vals.forEach((val, idx)=>{
      const li = document.createElement('li');
      li.textContent = val;
      // Delete button for each status
      const del = document.createElement('button'); del.textContent = 'x'; del.style.marginLeft = '8px'; del.style.background='#c73636';
      del.onclick = () => {
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        list.splice(idx,1);
        localStorage.setItem(key, JSON.stringify(list));
        renderStatuses();
      };
      li.appendChild(del);
      ul.appendChild(li);
    });
    section.appendChild(ul);
    // Add new status input
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'New status';
    const addBtn = document.createElement('button'); addBtn.textContent = 'Add';
    addBtn.onclick = () => {
      const val = input.value.trim();
      if(val){
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        if(!list.includes(val)){
          list.push(val);
          localStorage.setItem(key, JSON.stringify(list));
          renderStatuses();
        }
        input.value = '';
      }
    };
    section.appendChild(input);
    section.appendChild(addBtn);
    container.appendChild(section);
  });
}

// Render category management UI in settings page
function renderCategories(){
  const container = document.getElementById('categorySettings');
  if(!container) return;
  container.innerHTML = '';
  Object.keys(DEFAULT_CATEGORIES).forEach(key=>{
    let vals = JSON.parse(localStorage.getItem(key) || '[]');
    if(!vals || vals.length === 0){ vals = DEFAULT_CATEGORIES[key]; localStorage.setItem(key, JSON.stringify(vals)); }
    const section = document.createElement('div');
    section.className = 'category-section';
    const title = key.replace(/([A-Z])/g, ' $1').replace(/Types/,' Types').trim();
    const heading = document.createElement('h3'); heading.textContent = title;
    section.appendChild(heading);
    const ul = document.createElement('ul');
    vals.forEach((val, idx)=>{
      const li = document.createElement('li'); li.textContent = val;
      const del = document.createElement('button'); del.textContent='x'; del.style.marginLeft='8px'; del.style.background='#c73636';
      del.onclick = () => {
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        list.splice(idx,1);
        localStorage.setItem(key, JSON.stringify(list));
        renderCategories();
      };
      li.appendChild(del);
      ul.appendChild(li);
    });
    section.appendChild(ul);
    const input = document.createElement('input'); input.type='text'; input.placeholder='New value';
    const addBtn = document.createElement('button'); addBtn.textContent='Add';
    addBtn.onclick = () => {
      const val = input.value.trim();
      if(val){
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        if(!list.includes(val)){
          list.push(val);
          localStorage.setItem(key, JSON.stringify(list));
          renderCategories();
        }
        input.value='';
      }
    };
    section.appendChild(input);
    section.appendChild(addBtn);
    container.appendChild(section);
  });
}

// Set up search/filter and export controls for list pages. Provide the ids of
// the search input, export button, table and the localStorage key containing
// the data. When the search field changes, table rows are filtered. When
// export is clicked a CSV file is generated and downloaded. Only simple
// top-level fields are exported; arrays and objects are stringified.
function setupListPage(searchId, exportId, tableId, storeKey){
  const searchEl = document.getElementById(searchId);
  const exportEl = document.getElementById(exportId);
  const tableEl = document.getElementById(tableId);
  if(searchEl && tableEl){
    searchEl.addEventListener('input', ()=>{
      const filter = searchEl.value.toLowerCase();
      Array.from(tableEl.rows).forEach((row, idx)=>{
        if(idx === 0) return; // skip header
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(filter) ? '' : 'none';
      });
    });
  }
  if(exportEl){
    exportEl.addEventListener('click', ()=>{
      const data = getStore(storeKey);
      if(!data || data.length===0){ alert('No data to export'); return; }
      // Determine columns from first record
      const keys = Object.keys(data[0]);
      let csv = keys.join(',') + '\n';
      data.forEach(obj=>{
        csv += keys.map(k=>{
          let val = obj[k];
          if(Array.isArray(val)){
            val = val.map(v=> typeof v==='object' ? JSON.stringify(v) : v).join('|');
          }
          if(val===undefined || val===null) val = '';
          val = String(val).replace(/"/g,'""');
          return '"'+val+'"';
        }).join(',') + '\n';
      });
      const blob = new Blob([csv], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const filename = storeKey + '_' + (new Date().toISOString().split('T')[0]);
      link.download = filename + '.csv';
      document.body.appendChild(link);
      link.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); document.body.removeChild(link); }, 0);
    });
    // Attach import UI for editable lists
    if (typeof canEdit === 'function' && canEdit()) {
      // Hidden file input (accept CSV and Excel)
      const importInput = document.createElement('input');
      importInput.type = 'file';
      importInput.accept = '.csv,.xlsx,.xls';
      importInput.style.display = 'none';
      importInput.addEventListener('change', (evt) => {
        const file = evt.target.files && evt.target.files[0];
        if(file) {
          importFromFile(file, storeKey);
        }
        // reset the input so the same file can be chosen again
        evt.target.value = '';
      });
      // Import button
      const importBtn = document.createElement('button');
      importBtn.textContent = 'Import';
      importBtn.style.marginLeft = '8px';
      importBtn.addEventListener('click', () => {
        importInput.click();
      });
      // Insert after export button
      if (exportEl.parentNode) {
        exportEl.parentNode.insertBefore(importBtn, exportEl.nextSibling);
        exportEl.parentNode.insertBefore(importInput, importBtn.nextSibling);
      }
    }
  }
}

// ====== Import utilities ======
// Dynamically load the XLSX library if not already present. Returns a
// promise that resolves when the library is available. We load from
// CDN for convenience; in offline deployments this should be replaced
// with a locally hosted copy of SheetJS.
function loadXLSX(){
  return new Promise((resolve, reject) => {
    if (typeof XLSX !== 'undefined') return resolve();
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load XLSX library'));
    document.head.appendChild(script);
  });
}

// Parse a CSV string into an array of objects. Assumes the first row
// contains header names. Simple parser that does not support nested
// quotes or escaped commas; export files produced by this application
// are compatible. Arrays encoded with | delimiters will be preserved.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length > 0);
  if (lines.length === 0) return [];
  // Extract header row and remove surrounding quotes
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const row = [];
    let cur = '';
    let inside = false;
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        inside = !inside;
        continue;
      }
      if (ch === ',' && !inside) {
        row.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    row.push(cur);
    const obj = {};
    headers.forEach((h, idx) => {
      let val = row[idx] !== undefined ? row[idx] : '';
      val = val.replace(/^"|"$/g, '');
      // Convert pipe-delimited arrays
      if (val.includes('|')) {
        const parts = val.split('|').map(p => p.trim());
        val = parts.map(p => {
          if ((p.startsWith('{') && p.endsWith('}')) || (p.startsWith('[') && p.endsWith(']'))) {
            try { return JSON.parse(p); } catch (e) { return p; }
          }
          return p;
        });
      } else if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
        try { val = JSON.parse(val); } catch (e) {}
      }
      obj[h] = val;
    });
    records.push(obj);
  }
  return records;
}

// Import data from a selected file into the given localStorage key. Supports
// CSV and Excel formats. After importing, data is persisted and a page
// reload is triggered to update the UI. For actions and complaints, tasks
// will be synced to the backend for reminder scheduling.
function importFromFile(file, storeKey) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  const reader = new FileReader();
  reader.onload = async function(event) {
    const data = event.target.result;
    try {
      let records = [];
      if (ext === 'csv') {
        records = parseCSV(data);
      } else if (ext === 'xlsx' || ext === 'xls') {
        await loadXLSX();
        const wb = XLSX.read(data, { type: 'binary' });
        const sheetName = wb.SheetNames[0];
        records = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
      } else {
        alert('Unsupported file type: ' + ext);
        return;
      }
      // Persist imported records
      if (Array.isArray(records)) {
        setStore(storeKey, records);
        // If importing actions or complaints, sync tasks to backend
        if (storeKey === 'actions' || storeKey === 'complaints') {
          updateBackendTasks();
        }
        alert('Import successful.');
        // Reload page to reflect new data
        location.reload();
      } else {
        alert('No records found in file.');
      }
    } catch (err) {
      console.error('Failed to import file', err);
      alert('Failed to import: ' + err.message);
    }
  };
  // Use appropriate reader method
  if (ext === 'xlsx' || ext === 'xls') {
    reader.readAsBinaryString(file);
  } else {
    reader.readAsText(file);
  }
}

// Populate a select element with employees for assignment. If allowBlank is true,
// include an empty option at the top. Use employee id as option value and name
// as display text. Employees are loaded from localStorage.
function populateEmployeeSelect(selectId, allowBlank = true){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const employees = getStore('employees') || [];
  sel.innerHTML = '';
  if(allowBlank){
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Select --';
    sel.appendChild(opt);
  }
  employees.forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.id;
    opt.textContent = emp.name + (emp.empId ? ` (${emp.empId})` : '');
    sel.appendChild(opt);
  });
}

// Populate a select element with potential assignees. This helper combines
// both employees and system users into a single list so that tasks can be
// assigned to either category. Each option value is prefixed with
// "emp-" for employees or "usr-" for users to make it easy to determine
// the record type when processing submissions. The display text includes
// identifying information for clarity. If allowBlank is true, an empty
// option is inserted at the top.
function populateAssigneeSelect(selectId, allowBlank = true){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const employees = getStore('employees') || [];
  const users = getStore('users') || [];
  sel.innerHTML = '';
  if(allowBlank){
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Select --';
    sel.appendChild(opt);
  }
  // Append employees first
  employees.forEach(emp => {
    const opt = document.createElement('option');
    opt.value = 'emp-' + emp.id;
    opt.textContent = emp.name + (emp.empId ? ` (${emp.empId})` : '');
    sel.appendChild(opt);
  });
  // Append users next
  users.forEach(u => {
    // Exclude system accounts without email if desired; include all by default
    const opt = document.createElement('option');
    opt.value = 'usr-' + u.id;
    opt.textContent = 'User: ' + u.username + (u.role ? ` (${u.role})` : '');
    sel.appendChild(opt);
  });
}

// Send an email notification. In this demo, the function logs to console and
// shows a simple alert. To enable real emailing, configure SMTP or Graph API
// credentials in the notificationSettings object stored in localStorage and
// implement a backend service that uses those credentials. See settings page
// for storing host, port, username and password.
function sendEmail(to, subject, body){
  if(!to) return;
  const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
  // If a backend URL is configured, call it to send the email. Otherwise,
  // fall back to console and alert for development/testing purposes. The
  // backend should accept JSON {to, subject, html} and return a JSON
  // response. See README in backend folder for details.
  const backend = settings.backendUrl;
  // Construct email body with dashboard link and guidance
  let fullBody = body || '';
  try {
    const baseUrl = window.location.origin;
    fullBody += `<p>You can access your dashboard here: <a href="${baseUrl}/index.html">Dashboard</a></p>`;
    fullBody += '<p>After logging in, locate your pending tasks in the My Pending Tasks section. Select an action to start or mark it complete. When completing an action, please provide any comments or evidence describing your work.</p>';
  } catch (e) {
    // In non‑browser contexts, fall back to original body
    fullBody = body;
  }
  const payload = { to: to, subject: subject, html: fullBody };
  if(backend){
    try {
      fetch(backend, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(res => {
        if(!res.ok) throw new Error('Network response was not ok');
        return res.json();
      }).then(data => {
        console.log('Email sent via backend:', data);
      }).catch(err => {
        console.error('Failed to send email via backend:', err);
        alert(`Failed to send email to ${to}: ${err.message}`);
      });
    } catch (ex) {
      console.error('Exception sending email', ex);
      alert(`Failed to send email to ${to}: ${ex.message}`);
    }
  } else {
    // Example placeholder: log to console
    console.log('sendEmail called with:', to, subject, body);
    // Show user feedback in the UI
    alert(`Notification email queued to ${to}: ${subject}`);
  }
}

// Synchronise tasks with the backend. This function sends the current lists
// of actions and complaints to the backend service so that automated
// reminders can run on the server. It derives the updateTasks endpoint
// from the configured backendUrl by replacing '/sendEmail' with
// '/updateTasks'. If no backend is configured, the function does
// nothing. Errors are logged to the console but do not interrupt the UI.
function updateBackendTasks(){
  try {
    const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    const backend = settings.backendUrl;
    if(!backend) return;
    // derive base URL by removing any trailing '/sendEmail'
    let base = backend;
    if(base.endsWith('/sendEmail')) base = base.slice(0, -'/sendEmail'.length);
    const url = base + '/updateTasks';
    const actions = getStore('actions') || [];
    const complaints = getStore('complaints') || [];
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions, complaints })
    }).then(res => {
      if(!res.ok){ console.warn('updateBackendTasks failed with status', res.status); }
      return res.json().catch(()=>null);
    }).then(data => {
      if(data && data.status) console.log('Tasks synced to backend:', data.status);
    }).catch(err => {
      console.warn('updateBackendTasks error:', err);
    });
  } catch (ex) {
    console.warn('updateBackendTasks exception:', ex);
  }
}

// Add an entry to the audit log. Logs consist of a timestamp, user, action and
// description. The current logged‑in user is determined via getCurrentUser().
// Logs are stored in localStorage under the key 'auditLogs'. A unique id is
// also recorded for each entry.
// Add an entry to the audit log.  Each log records metadata about the
// operation, including the user performing the action, an optional
// entity identifier, before/after snapshots and module context.  The
// optional third parameter may include: entity (string/id), before
// (object/string), after (object/string) and module (string).  IP
// address cannot be determined in this offline demo, so it is always
// recorded as 'N/A'.  Logs are stored in localStorage under the
// 'auditLogs' key and contain a unique id.
function addAuditLog(action, description, details) {
  try {
    let logs = JSON.parse(localStorage.getItem('auditLogs') || '[]');
    const userObj = getCurrentUser();
    const logEntry = {
      id: uid(),
      timestamp: new Date().toISOString(),
      user: (userObj && userObj.username) ? userObj.username : 'system',
      userId: (userObj && userObj.id) ? userObj.id : '',
      // Record the client's IP address using the globally captured value or override from details
      ip: (details && details.ip) ? details.ip : APP_IP,
      action: action || '',
      description: description || ''
    };
    if (details && typeof details === 'object') {
      // merge any supplied details into the log entry.  This may include the
      // entity id, before/after snapshots or module context.
      if (details.entity !== undefined) logEntry.entity = details.entity;
      if (details.before !== undefined) logEntry.before = details.before;
      if (details.after !== undefined) logEntry.after = details.after;
      if (details.module !== undefined) logEntry.module = details.module;
      if (details.extra !== undefined) logEntry.extra = details.extra;
    }
    logs.push(logEntry);
    localStorage.setItem('auditLogs', JSON.stringify(logs));
  } catch (ex) {
    console.error('Failed to add audit log', ex);
  }
}

// Render the audit log table. Reads log entries from localStorage and
// populates the table with id 'auditTable'. The newest entries appear first.
function renderAuditLogs(){
  const tbl = document.getElementById('auditTable');
  if(!tbl) return;
  let logs = JSON.parse(localStorage.getItem('auditLogs') || '[]');
  // sort descending by timestamp
  logs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  tbl.innerHTML = '<tr><th>Date/Time</th><th>User</th><th>Action</th><th>Description</th></tr>';
  logs.forEach(log => {
    const row = tbl.insertRow(-1);
    const dt = new Date(log.timestamp);
    const dateStr = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
    row.insertCell(0).innerText = dateStr;
    row.insertCell(1).innerText = log.user || '';
    row.insertCell(2).innerText = log.action || '';
    row.insertCell(3).innerText = log.description || '';
  });
}

// Populate filters on the audit logs page.  The user selector includes
// 'All Users' plus every user that appears in the audit log.  The module
// selector includes 'All Modules' and entries derived from DEFAULT_MODULES.
function populateAuditFilters() {
  const userSel = document.getElementById('logUserFilter');
  const moduleSel = document.getElementById('logModuleFilter');
  if (userSel) {
    userSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'All Users';
    userSel.appendChild(optAll);
    // derive users from logs
    const logs = JSON.parse(localStorage.getItem('auditLogs') || '[]');
    const users = [...new Set(logs.map(l => l.user).filter(u => u))];
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = u;
      userSel.appendChild(opt);
    });
  }
  if (moduleSel) {
    moduleSel.innerHTML = '';
    const optAllM = document.createElement('option');
    optAllM.value = '';
    optAllM.textContent = 'All Modules';
    moduleSel.appendChild(optAllM);
    DEFAULT_MODULES.forEach(mod => {
      const opt = document.createElement('option');
      opt.value = mod.label;
      opt.textContent = mod.label;
      moduleSel.appendChild(opt);
    });
  }
}

// Filter and render audit logs based on selected criteria: user, module,
// date range and search term.  Reads values from the filter inputs and
// updates the displayed logs accordingly.
function filterAuditLogs() {
  let logs = JSON.parse(localStorage.getItem('auditLogs') || '[]');
  // sort descending
  logs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  const userVal = document.getElementById('logUserFilter') ? document.getElementById('logUserFilter').value : '';
  const moduleVal = document.getElementById('logModuleFilter') ? document.getElementById('logModuleFilter').value : '';
  const startDateStr = document.getElementById('logStartDate') ? document.getElementById('logStartDate').value : '';
  const endDateStr = document.getElementById('logEndDate') ? document.getElementById('logEndDate').value : '';
  const searchText = document.getElementById('searchLogs') ? document.getElementById('searchLogs').value.toLowerCase() : '';
  let startDate = startDateStr ? new Date(startDateStr) : null;
  let endDate = endDateStr ? new Date(endDateStr) : null;
  // Normalize end date to include the whole day
  if (endDate) {
    endDate.setHours(23,59,59,999);
  }
  // Filter logs
  let filtered = logs.filter(log => {
    // user filter
    if (userVal && log.user !== userVal) return false;
    // module filter (module may be undefined)
    if (moduleVal && log.module !== moduleVal) return false;
    // date range filter
    const ts = new Date(log.timestamp);
    if (startDate && ts < startDate) return false;
    if (endDate && ts > endDate) return false;
    // search text across action and description
    if (searchText && !( (log.action || '').toLowerCase().includes(searchText) || (log.description || '').toLowerCase().includes(searchText) )) return false;
    return true;
  });
  // Render table
  const tbl = document.getElementById('auditTable');
  if(!tbl) return;
  tbl.innerHTML = '<tr><th>Date/Time</th><th>User</th><th>Action</th><th>Description</th></tr>';
  filtered.forEach(log => {
    const row = tbl.insertRow(-1);
    const dt = new Date(log.timestamp);
    row.insertCell(0).innerText = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
    row.insertCell(1).innerText = log.user || '';
    row.insertCell(2).innerText = log.action || '';
    row.insertCell(3).innerText = log.description || '';
  });
}

// Check for due dates and send reminder notifications based on reminderDays.
// This function iterates over actions and complaints and sends reminders to
// the assigned/owner email when the due date is approaching. A record will
// only receive one reminder per due date (tracked via remindedAt property).
function checkReminders(){
  const now = new Date();
  let sent = 0;
  // Helper to parse date strings (YYYY-MM-DD or ISO)
  const parseDate = (str) => { return str ? new Date(str) : null; };
  // Actions reminders
  let actions = getStore('actions') || [];
  actions.forEach(a => {
    if(!a.due) return;
    const dueDate = parseDate(a.due);
    if(!dueDate) return;
    // Determine number of days before due date to remind.  Always parse
    // reminderDays as an integer; if unset or invalid, fall back to the
    // default configured in notificationSettings.  A zero or negative
    // value disables reminders.
    const notif = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    const defRd = parseInt(notif.reminderDays) || 0;
    let rd = (a.reminderDays !== undefined) ? parseInt(a.reminderDays) : defRd;
    if(isNaN(rd) || rd <= 0) return;
    const remindDate = new Date(dueDate);
    remindDate.setDate(remindDate.getDate() - rd);
    // Only remind if today >= remindDate and not after due date and not closed
    if(now >= remindDate && now <= dueDate && a.status !== 'Verified Closed'){
      if(!a.remindedAt){
        // Send email
        if(a.ownerEmail){
          const subject = `Action Reminder: ${a.title}`;
          const body = `This is a reminder that the action "${a.title}" is due on ${a.due}. Please take necessary steps.`;
          sendEmail(a.ownerEmail, subject, body);
          a.remindedAt = now.toISOString();
          sent++;
        }
      }
    }
  });
  setStore('actions', actions);
  // Complaint reminders (assigned user)
  let complaints = getStore('complaints') || [];
  complaints.forEach(c => {
    if(!c.dueDate) return;
    const dueDate = parseDate(c.dueDate);
    if(!dueDate) return;
    const notifC = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
    const defRc = parseInt(notifC.reminderDays) || 0;
    let rd = (c.reminderDays !== undefined) ? parseInt(c.reminderDays) : defRc;
    if(isNaN(rd) || rd <= 0) return;
    const remindDate = new Date(dueDate);
    remindDate.setDate(remindDate.getDate() - rd);
    if(now >= remindDate && now <= dueDate && c.status !== 'Closed'){
      if(!c.remindedAt){
        if(c.assignedEmail){
          const subject = `Complaint Reminder: ${c.title}`;
          const body = `This is a reminder that complaint ${c.ccNo} (${c.title}) is due on ${c.dueDate}. Please follow up.`;
          sendEmail(c.assignedEmail, subject, body);
          c.remindedAt = now.toISOString();
          sent++;
        }
      }
    }
  });
  setStore('complaints', complaints);
  if(sent > 0){
    console.log('Reminders sent:', sent);
  }

  // After processing reminders, evaluate overdue items and trigger escalation
  checkEscalations();

  // Apply retention rules after reminders and escalations.  This ensures that
  // outdated records are cleaned up regularly according to admin‑defined
  // retention periods.  Purging happens quietly and logs are written to the
  // audit log.
  if(typeof applyRetention === 'function'){
    applyRetention();
  }
}

// Check for overdue actions and complaints and trigger escalation rules.
// If an item is past its due date and still open, an escalation log is
// recorded and a notification entry is created.  Each record is only
// escalated once (tracked via the `escalatedAt` property).  Escalations
// are written to the audit log with module and entity details for
// traceability.
function checkEscalations() {
  const now = new Date();
  // Helper to send escalation email; currently uses sendEmail placeholder
  const notifyEscalation = (email, subject, body) => {
    if (email) {
      sendEmail(email, subject, body);
    }
  };
  // Actions
  let actions = getStore('actions') || [];
  let escalatedCount = 0;
  actions.forEach(a => {
    if (!a.due || a.status === 'Verified Closed') return;
    const dueDate = new Date(a.due);
    if (now > dueDate) {
      if (!a.escalatedAt) {
        // mark escalated
        a.escalatedAt = now.toISOString();
        escalatedCount++;
        // Determine escalation recipient: if ownerEmail exists use it; otherwise fallback to fromEmail
        const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
        const to = a.ownerEmail || settings.fromEmail || '';
        const subj = `Escalation: Action Overdue - ${a.title}`;
        const msg = `The action "${a.title}" assigned to you is overdue since ${a.due}. Please address this immediately.`;
        notifyEscalation(to, subj, msg);
        // Record audit log
        addAuditLog('Escalation', `Action ${a.title} is overdue`, { entity: a.id, module: 'Action Management' });
      }
    }
  });
  if (escalatedCount > 0) {
    setStore('actions', actions);
  }
  // Complaints escalation – overdue complaints
  let complaints = getStore('complaints') || [];
  let compEsc = 0;
  complaints.forEach(c => {
    if (!c.dueDate || c.status === 'Closed') return;
    const due = new Date(c.dueDate);
    if (now > due) {
      if (!c.escalatedAt) {
        c.escalatedAt = now.toISOString();
        compEsc++;
        const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
        const to = c.assignedEmail || settings.fromEmail || '';
        const subj = `Escalation: Complaint Overdue - ${c.ccNo}`;
        const msg = `Complaint ${c.ccNo} (${c.title}) is overdue since ${c.dueDate}. Please review.`;
        notifyEscalation(to, subj, msg);
        addAuditLog('Escalation', `Complaint ${c.ccNo} is overdue`, { entity: c.id, module: 'Customer Complaints' });
      }
    }
  });
  if (compEsc > 0) {
    setStore('complaints', complaints);
  }
}

// ====== Global page initialisation ======
document.addEventListener('DOMContentLoaded', ()=>{
  // Determine page type
  const path = window.location.pathname;
  // Apply RTL layout if enabled.  Reads the 'rtl' flag from localStorage and
  // sets the dir attribute on the root document element accordingly.  This
  // should happen early to avoid flash of incorrect layout.
  const rtlEnabled = localStorage.getItem('rtl') === 'true';
  if(rtlEnabled){
    document.documentElement.setAttribute('dir','rtl');
  } else {
    document.documentElement.setAttribute('dir','ltr');
  }
  // Login page: attach login handler and skip other logic
  if(path.includes('login.html')){
    initUsers();
    // Initialise role permissions before requiring login so that
    // navigation filtering can be applied correctly after login.
    initRolePermissions();
    const form = document.getElementById('loginForm');
    if(form){
      form.addEventListener('submit', e=>{
        e.preventDefault();
        // Accept either username or email for login
        loginUser(document.getElementById('loginUsername').value.trim(), document.getElementById('loginPassword').value);
      });
    }
    // Handle self‑signup requests.  New users can request an account by submitting the
    // signup form.  The account will be created but marked inactive until
    // an administrator approves it.  Emails must be unique.
    const signupForm = document.getElementById('signupForm');
    if(signupForm){
      signupForm.addEventListener('submit', e => {
        e.preventDefault();
        const email = document.getElementById('signupEmail').value.trim().toLowerCase();
        const pw = document.getElementById('signupPassword').value;
        const pw2 = document.getElementById('signupConfirm').value;
        const err = document.getElementById('signupError');
        if(!email){ if(err) err.textContent = 'Email is required.'; return; }
        if(!pw){ if(err) err.textContent = 'Password is required.'; return; }
        if(pw !== pw2){ if(err) err.textContent = 'Passwords do not match.'; return; }
        let users = getStore('users');
        // ensure unique email
        const exists = users.some(u => (u.username||'').toLowerCase() === email || (u.email||'').toLowerCase() === email);
        if(exists){ if(err) err.textContent = 'An account with this email already exists.'; return; }
        const newUser = {
          id: uid(),
          username: email,
          password: btoa(pw),
          role: 'user',
          email: email,
          active: false,
          lastLogin: '',
          employeeId: ''
        };
        users.push(newUser);
        setStore('users', users);
        // Audit log for admin to see
        addAuditLog('Signup Request', 'New user signup request for ' + email);
        if(err) err.style.color = 'green';
        if(err) err.textContent = 'Account created. Awaiting admin approval.';
        signupForm.reset();
      });
    }
    return;
  }

  // For all other pages except closure report: require login
  if(!path.includes('closure_report.html')){
    initUsers();
    // Initialise edit roles before requiring login so that role-based
    // permissions are available immediately. This creates a default
    // editable roles list if one does not exist.
    initEditRoles();
    requireLogin();
    // Apply module permissions to the navigation bar after login
    applyRolePermissions();
  }

  // Update navbar user display and admin items if they exist
  const navUser = document.getElementById('navUser');
  const current = getCurrentUser();
  if(navUser && current && current.username){
    navUser.textContent = current.username + ' (' + current.role + ')';
  }
  const navSettings = document.getElementById('navSettings');
  // Hide the Settings link for users who are not authorised to edit
  if(navSettings && !canEdit()){
    navSettings.style.display = 'none';
  }
  // Hide Audit Logs link for non-admins
  const navLogs = document.getElementById('navLogs');
  if(navLogs && !isAdmin()){
    navLogs.style.display = 'none';
  }
  const navLogout = document.getElementById('navLogout');
  if(navLogout){
    navLogout.addEventListener('click', (e)=>{ e.preventDefault(); logoutUser(); });
  }

  // After updating navigation, check and send any due reminders. This runs on
  // every page load except the login and closure report.
  checkReminders();

  // Settings page initialisation
  if(path.includes('settings.html')){
    if(!isAdmin()){
      // Only admins can access settings
      window.location = 'index.html';
      return;
    }
    // Render lists and attach handlers
    renderUsers();
    // Set up search/filter and export for user list
    setupListPage('userSearch', 'userExport', 'userTable', 'users');
    renderStatuses();
    renderCategories();
    // Render roles and role training requirements
    renderRoles();
    renderRoleTraining();
    // Render courses and role-course requirements
    renderCourses();
    renderRoleCourses();
    // Render roles permitted to edit data
    renderEditRoles();
    // Render QA verification roles
    renderQaRoles();
    // Render role/module permissions table
    renderRolePermissions();
    // Populate the employee dropdown for new user creation
    const empSelect = document.getElementById('newUserEmployee');
    if (empSelect) {
      empSelect.innerHTML = '<option value="">-- Link Employee (optional) --</option>';
      const emps = getStore('employees') || [];
      emps.forEach(emp => {
        const opt = document.createElement('option');
        opt.value = String(emp.id);
        opt.textContent = emp.name + (emp.email ? ' (' + emp.email + ')' : '');
        empSelect.appendChild(opt);
      });
    }
    const addUserForm = document.getElementById('addUserForm');
    if(addUserForm){
      addUserForm.addEventListener('submit', e=>{
        e.preventDefault();
        const username = document.getElementById('newUsername').value.trim();
        const password = document.getElementById('newPassword').value;
        const role = document.getElementById('newRole').value;
        const emailField = document.getElementById('newUserEmail');
        const email = emailField ? emailField.value.trim() : '';
        const empSel = document.getElementById('newUserEmployee');
        const employeeId = empSel ? empSel.value : '';
        if (username && password) {
          let users = getStore('users');
          if (users.some(u => u.username === username)) {
            alert('User ' + username + ' already exists');
            return;
          }
          // new users are active by default and have no last login yet
          users.push({ id: uid(), username, password: btoa(password), role, email: email || '', employeeId: employeeId || '', active: true, lastLogin: '' });
          setStore('users', users);
          // Record audit log
          addAuditLog('Add User', 'User ' + username + ' created');
          document.getElementById('newUsername').value = '';
          document.getElementById('newPassword').value = '';
          if (emailField) emailField.value = '';
          renderUsers();
        }
      });
    }
    // Prefill notification settings and attach save handler
    const notifForm = document.getElementById('notificationForm');
    if(notifForm){
      // Load existing values from localStorage
      const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
      if(settings){
        if(document.getElementById('smtpHost')) document.getElementById('smtpHost').value = settings.smtpHost || '';
        if(document.getElementById('smtpPort')) document.getElementById('smtpPort').value = settings.smtpPort || '';
        if(document.getElementById('smtpUser')) document.getElementById('smtpUser').value = settings.smtpUser || '';
        if(document.getElementById('smtpPass')) document.getElementById('smtpPass').value = settings.smtpPass || '';
        if(document.getElementById('fromEmail')) document.getElementById('fromEmail').value = settings.fromEmail || '';
        if(document.getElementById('defaultReminder')) document.getElementById('defaultReminder').value = settings.reminderDays || '';
        if(document.getElementById('backendUrl')) document.getElementById('backendUrl').value = settings.backendUrl || '';
      }
      notifForm.addEventListener('submit', e => {
        e.preventDefault();
        const newSettings = {
          smtpHost: document.getElementById('smtpHost') ? document.getElementById('smtpHost').value.trim() : '',
          smtpPort: document.getElementById('smtpPort') ? document.getElementById('smtpPort').value.trim() : '',
          smtpUser: document.getElementById('smtpUser') ? document.getElementById('smtpUser').value.trim() : '',
          smtpPass: document.getElementById('smtpPass') ? document.getElementById('smtpPass').value : '',
          fromEmail: document.getElementById('fromEmail') ? document.getElementById('fromEmail').value.trim() : '',
          reminderDays: (function(){ const val = document.getElementById('defaultReminder') ? document.getElementById('defaultReminder').value : ''; const p=parseInt(val); return isNaN(p) ? 0 : p; })(),
          backendUrl: document.getElementById('backendUrl') ? document.getElementById('backendUrl').value.trim() : ''
        };
        localStorage.setItem('notificationSettings', JSON.stringify(newSettings));
        alert('Notification settings saved');
      });
    }
    // Initialise risk threshold form, RTL toggle and retention/reminder table
    // Risk thresholds
    const thrForm = document.getElementById('riskThresholdForm');
    if(thrForm){
      const thr = getRiskThresholds();
      if(document.getElementById('riskThrLow')) document.getElementById('riskThrLow').value = thr.low;
      if(document.getElementById('riskThrMedium')) document.getElementById('riskThrMedium').value = thr.medium;
      if(document.getElementById('riskThrHigh')) document.getElementById('riskThrHigh').value = thr.high;
      thrForm.addEventListener('submit', e=>{
        e.preventDefault();
        const low = parseFloat(document.getElementById('riskThrLow').value);
        const med = parseFloat(document.getElementById('riskThrMedium').value);
        const high = parseFloat(document.getElementById('riskThrHigh').value);
        setRiskThresholds({ low, medium: med, high });
        alert('Risk thresholds saved');
      });
    }
    // RTL toggle
    const rtlToggle = document.getElementById('rtlToggle');
    if(rtlToggle){
      const currentRtl = localStorage.getItem('rtl') === 'true';
      rtlToggle.checked = currentRtl;
      rtlToggle.addEventListener('change', e=>{
        const val = e.target.checked;
        localStorage.setItem('rtl', val ? 'true' : 'false');
        alert('Reloading to apply layout changes.');
        location.reload();
      });
    }
    // Retention & reminder settings table
    const retentionTable = document.getElementById('retentionTable');
    const saveRet = document.getElementById('saveRetention');
    if(retentionTable && saveRet){
      const modules = ['actions','complaints','audits','risks','permits','safety','sds','training'];
      retentionTable.innerHTML = '<tr><th>Module</th><th>Retention Days</th><th>Reminder Days</th></tr>';
      modules.forEach(mod => {
        const row = retentionTable.insertRow();
        const cellMod = row.insertCell(0); cellMod.textContent = mod;
        const cellRet = row.insertCell(1);
        const retInput = document.createElement('input');
        retInput.type = 'number';
        retInput.min = 0;
        retInput.id = 'ret_'+mod;
        const rVal = getRetention(mod);
        retInput.value = (!isNaN(rVal) && rVal !== null) ? rVal : '';
        cellRet.appendChild(retInput);
        const cellRem = row.insertCell(2);
        const remInput = document.createElement('input');
        remInput.type = 'number';
        remInput.min = 0;
        remInput.id = 'rem_'+mod;
        const mVal = getModuleReminder(mod);
        remInput.value = (!isNaN(mVal) && mVal !== null) ? mVal : '';
        cellRem.appendChild(remInput);
      });
      saveRet.addEventListener('click', ()=>{
        modules.forEach(mod => {
          const retVal = parseInt(document.getElementById('ret_'+mod).value);
          const remVal = parseInt(document.getElementById('rem_'+mod).value);
          if(!isNaN(retVal)) setRetention(mod, retVal);
          if(!isNaN(remVal)) setModuleReminder(mod, remVal);
        });
        alert('Retention and reminder settings saved');
      });
    }
    return;
  }
  // Audit logs page initialisation
  if(path.includes('audit_logs.html')){
    // Only admins can view logs; redirect others to dashboard
    if(!isAdmin()){
      window.location = 'index.html';
      return;
    }
    // Initial rendering and filter setup
    populateAuditFilters();
    filterAuditLogs();
    // Attach filter button
    const applyBtn = document.getElementById('applyLogFilter');
    if(applyBtn){
      applyBtn.addEventListener('click', e => {
        e.preventDefault();
        filterAuditLogs();
      });
    }
    // Also update table when search is typed or dates/filters change
    const inputs = ['logUserFilter','logModuleFilter','logStartDate','logEndDate','searchLogs'];
    inputs.forEach(id => {
      const el = document.getElementById(id);
      if(el){ el.addEventListener('change', filterAuditLogs); el.addEventListener('keyup', filterAuditLogs); }
    });
    // Export logs button
    const exportBtn = document.getElementById('exportLogs');
    if(exportBtn){
      exportBtn.addEventListener('click', e => {
        e.preventDefault();
        // Export currently filtered logs to CSV
        let logs = JSON.parse(localStorage.getItem('auditLogs') || '[]');
        logs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
        const userVal = document.getElementById('logUserFilter') ? document.getElementById('logUserFilter').value : '';
        const moduleVal = document.getElementById('logModuleFilter') ? document.getElementById('logModuleFilter').value : '';
        const startDateStr = document.getElementById('logStartDate') ? document.getElementById('logStartDate').value : '';
        const endDateStr = document.getElementById('logEndDate') ? document.getElementById('logEndDate').value : '';
        const searchText = document.getElementById('searchLogs') ? document.getElementById('searchLogs').value.toLowerCase() : '';
        let startDate = startDateStr ? new Date(startDateStr) : null;
        let endDate = endDateStr ? new Date(endDateStr) : null;
        if(endDate) endDate.setHours(23,59,59,999);
        const filtered = logs.filter(log => {
          if(userVal && log.user !== userVal) return false;
          if(moduleVal && log.module !== moduleVal) return false;
          const ts = new Date(log.timestamp);
          if(startDate && ts < startDate) return false;
          if(endDate && ts > endDate) return false;
          if(searchText && !( (log.action||'').toLowerCase().includes(searchText) || (log.description||'').toLowerCase().includes(searchText) )) return false;
          return true;
        });
        let csv = 'Date/Time,User,Action,Description\n';
        filtered.forEach(log => {
          const dt = new Date(log.timestamp);
          const dateStr = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
          const row = [dateStr, log.user || '', log.action || '', log.description || ''].map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',');
          csv += row + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'audit_logs.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }
    return;
  }
});

// ====== Equipment page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('equipmentForm');
  if(form){
    form.addEventListener('submit', e=>{
      e.preventDefault();
      let equipment = getStore('equipment');
      const id = uid();
      const rec = {
        id,
        tag: document.getElementById('eqId').value,
        name: document.getElementById('eqName').value,
        model: document.getElementById('eqModel').value,
        location: document.getElementById('eqLocation').value,
        owner: document.getElementById('eqOwner').value,
        purchase: document.getElementById('eqPurchase').value,
        nextMaint: document.getElementById('eqMaintenance').value,
        nextCalib: document.getElementById('eqCalibration').value,
        status: document.getElementById('eqStatus').value || 'Active',
        actions: [],
        history: ['Equipment added']
      };
      equipment.push(rec);
      setStore('equipment', equipment);
      // Record audit log
      addAuditLog('Add Equipment', 'Equipment ' + rec.tag + ' added');
      // Refresh page
      location.reload();
    });
    // Populate equipment table
    const table = document.getElementById('equipmentTable');
    const list = getStore('equipment');
    list.forEach(eq => {
      const r = table.insertRow();
      r.insertCell(0).innerText = eq.tag || '';
      r.insertCell(1).innerText = eq.name || '';
      r.insertCell(2).innerText = eq.model || '';
      r.insertCell(3).innerText = eq.location || '';
      r.insertCell(4).innerText = eq.owner || '';
      r.insertCell(5).innerText = fmtD(eq.nextMaint);
      r.insertCell(6).innerText = fmtD(eq.nextCalib);
      const sCell = r.insertCell(7);
      sCell.innerHTML = badgeStatus(eq.status || 'Active');
      const mCell = r.insertCell(8);
      const mBtn = document.createElement('button');
      mBtn.textContent = 'Manage';
      mBtn.onclick = () => { window.location = 'equipment_detail.html?id=' + eq.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(9);
      const dBtn = document.createElement('button');
      dBtn.textContent = 'Delete';
      dBtn.style.background = '#c73636';
      dBtn.onclick = () => deleteEquipment(eq.id);
      dCell.appendChild(dBtn);
    });
    // Setup search and export controls
    setupListPage('searchEquipment', 'exportEquipment', 'equipmentTable', 'equipment');
  }
});

// Equipment deletion
function deleteEquipment(id){
  if(!confirm('Delete equipment record?')) return;
  let equipment = getStore('equipment');
  const rec = findById(equipment, id);
  equipment = equipment.filter(x => String(x.id) !== String(id));
  setStore('equipment', equipment);
  addAuditLog('Delete Equipment', 'Equipment ' + (rec ? rec.tag : id) + ' deleted');
  updateBackendTasks();
  location.reload();
}

// ====== Equipment detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('equipment_detail.html')) return;
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  let equipment = getStore('equipment');
  const rec = findById(equipment, id);
  if(!rec){
    const el = document.getElementById('equipmentHeader');
    if(el) el.innerHTML = '<p>Equipment not found.</p>';
    return;
  }
  // Header
  document.getElementById('equipmentHeader').innerHTML = `<b>${rec.tag}</b> — <b>${rec.name}</b><br>Model: ${rec.model || '-'} | Location: ${rec.location || '-'} | Owner: ${rec.owner || '-'} | Purchase: ${fmtD(rec.purchase)}`;
  // Overview cards
  const ov = document.getElementById('equipmentOverview');
  if(ov){
    ov.innerHTML = `
      <div class="grid-2">
        <div class="card"><b>Next Maintenance</b><br>${fmtD(rec.nextMaint) || '-'}</div>
        <div class="card"><b>Next Calibration</b><br>${fmtD(rec.nextCalib) || '-'}</div>
      </div>`;
  }
  // Status form prefill
  const statusSel = document.getElementById('equipmentStatus');
  const nextMaint = document.getElementById('equipmentNextMaint');
  const nextCalib = document.getElementById('equipmentNextCalib');
  if(statusSel) statusSel.value = rec.status || 'Active';
  if(nextMaint) nextMaint.value = rec.nextMaint || '';
  if(nextCalib) nextCalib.value = rec.nextCalib || '';
  window.saveEquipmentStatus = function(){
    rec.status = document.getElementById('equipmentStatus').value;
    rec.nextMaint = document.getElementById('equipmentNextMaint').value;
    rec.nextCalib = document.getElementById('equipmentNextCalib').value;
    rec.history = rec.history || [];
    rec.history.push('Status updated to ' + rec.status + '; dates updated');
    setStore('equipment', equipment);
    addAuditLog('Update Equipment', 'Equipment ' + rec.tag + ' status updated');
    updateBackendTasks();
    alert('Saved');
    location.reload();
  };
  // List tasks
  const taskList = document.getElementById('equipmentActionList');
  if(taskList){
    (rec.actions || []).forEach(a => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner || '-'}, Due: ${fmtD(a.due)}) — Status: ${a.status || 'Open'}`;
      taskList.appendChild(li);
    });
  }
  // Prepopulate calibrations list
  const calibList = document.getElementById('equipmentCalibList');
  if(calibList){
    (rec.calibrations || []).forEach(c => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${c.certNo}</b> (${fmtD(c.date)}) — Result: ${c.result || ''}${c.comments ? ' — ' + c.comments : ''}`;
      calibList.appendChild(li);
    });
  }
  // Add calibration form handler
  const calibForm = document.getElementById('equipmentCalibForm');
  if(calibForm){
    calibForm.addEventListener('submit', e => {
      e.preventDefault();
      const certNo = document.getElementById('calibCertNo').value;
      const date = document.getElementById('calibDate').value;
      const result = document.getElementById('calibResult').value;
      const comments = document.getElementById('calibComments').value;
      const c = { id: uid(), certNo: certNo, date: date, result: result, comments: comments };
      rec.calibrations = rec.calibrations || [];
      rec.calibrations.push(c);
      rec.history = rec.history || [];
      rec.history.push('Calibration recorded: ' + certNo + ' (' + result + ')');
      // If calibration fails, create a corrective action
      if(result && result.toLowerCase() === 'fail'){
        const a = {
          id: uid(),
          title: 'Calibration failed for ' + rec.tag,
          owner: rec.owner || '',
          dept: rec.location || '',
          due: '',
          status: 'Open',
          source: 'Equipment Calibration',
          sourceRef: rec.tag
        };
        rec.actions = rec.actions || [];
        rec.actions.push(a);
        let actions = getStore('actions'); actions.push({ ...a }); setStore('actions', actions);
        rec.history.push('Action created: ' + a.title);
      }
      setStore('equipment', equipment);
      addAuditLog('Add Calibration', 'Calibration ' + certNo + ' recorded for equipment ' + rec.tag);
      updateBackendTasks();
      alert('Calibration saved');
      location.reload();
    });
  }
  // Add task form handler
  const actionForm = document.getElementById('equipmentActionForm');
  if(actionForm){
    actionForm.addEventListener('submit', e => {
      e.preventDefault();
      const a = {
        id: uid(),
        title: document.getElementById('eqTaskTitle').value,
        owner: document.getElementById('eqTaskOwner').value,
        dept: document.getElementById('eqTaskDept').value,
        due: document.getElementById('eqTaskDue').value,
        status: 'Open',
        source: 'Equipment',
        sourceRef: rec.tag
      };
      rec.actions = rec.actions || [];
      rec.actions.push(a);
      rec.history = rec.history || [];
      rec.history.push('Task added: ' + a.title);
      // Add to global actions store
      let actions = getStore('actions');
      actions.push({ ...a });
      setStore('actions', actions);
      setStore('equipment', equipment);
      addAuditLog('Add Equipment Task', 'Task ' + a.title + ' added to equipment ' + rec.tag);
      updateBackendTasks();
      location.reload();
    });
  }
  // History list
  const hist = document.getElementById('equipmentHistory');
  if(hist){
    (rec.history || []).forEach(h => {
      let li = document.createElement('li');
      li.textContent = h;
      hist.appendChild(li);
    });
  }
  // Open first tab
  const firstTab = document.querySelector('.tablink');
  if(firstTab) firstTab.click();
});

// ====== Change Management page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('changeForm');
  if(form){
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      let changes = getStore('changes');
      const id = uid();
      const attachments = [];
      const fileInput = document.getElementById('changeFiles');
      if(fileInput && fileInput.files && fileInput.files.length){
        for(const file of fileInput.files){
          const reader = new FileReader();
          await new Promise(resolve => {
            reader.onload = evt => {
              attachments.push({ name: file.name, data: evt.target.result });
              resolve();
            };
          });
          reader.readAsDataURL(file);
        }
      }
      const rec = {
        id,
        no: nextChangeNo(id),
        title: document.getElementById('changeTitle').value,
        reason: document.getElementById('changeReason').value,
        impact: document.getElementById('changeImpact').value,
        approvals: document.getElementById('changeApprovals').value,
        attachments,
        status: 'Requested',
        actions: [],
        history: ['Change request submitted']
      };
      changes.push(rec);
      setStore('changes', changes);
      addAuditLog('Add Change Request', 'Change request ' + rec.no + ' created');
      location.reload();
    });
    // Populate change requests table
    const table = document.getElementById('changeTable');
    const list = getStore('changes');
    list.forEach(cr => {
      const r = table.insertRow();
      r.insertCell(0).innerText = cr.no;
      r.insertCell(1).innerText = cr.title || '';
      r.insertCell(2).innerText = cr.reason || '';
      const sCell = r.insertCell(3);
      sCell.innerHTML = badgeStatus(cr.status || 'Requested');
      const mCell = r.insertCell(4);
      const mBtn = document.createElement('button'); mBtn.textContent = 'Manage'; mBtn.onclick = () => { window.location = 'change_detail.html?id=' + cr.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(5);
      const dBtn = document.createElement('button'); dBtn.textContent = 'Delete'; dBtn.style.background = '#c73636'; dBtn.onclick = () => deleteChange(cr.id);
      dCell.appendChild(dBtn);
    });
    setupListPage('searchChange', 'exportChange', 'changeTable', 'changes');
  }
});

// Delete change request
function deleteChange(id){
  if(!confirm('Delete change request?')) return;
  let changes = getStore('changes');
  const rec = findById(changes, id);
  changes = changes.filter(x => String(x.id) !== String(id));
  setStore('changes', changes);
  addAuditLog('Delete Change Request', 'Change request ' + (rec ? rec.no : id) + ' deleted');
  updateBackendTasks();
  location.reload();
}

// ====== Change request detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('change_detail.html')) return;
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  let changes = getStore('changes');
  const rec = findById(changes, id);
  if(!rec){
    const el = document.getElementById('changeHeader');
    if(el) el.innerHTML = '<p>Change request not found.</p>';
    return;
  }
  document.getElementById('changeHeader').innerHTML = `<b>${rec.no}</b> — <b>${rec.title}</b><br>Reason: ${rec.reason || '-'} | Impact: ${rec.impact || '-'} | Approvals: ${rec.approvals || '-'}`;
  const ov = document.getElementById('changeOverview');
  if(ov){
    ov.innerHTML = `<div class="card"><b>Impact Analysis</b><br>${rec.impact || '-'}</div>`;
  }
  // Attachments display
  const filesDiv = document.getElementById('changeFilesList');
  if(filesDiv){
    filesDiv.innerHTML = '';
    if(rec.attachments && rec.attachments.length){
      rec.attachments.forEach(att => {
        const link = document.createElement('a');
        link.href = att.data;
        link.target = '_blank';
        link.download = att.name;
        link.textContent = att.name;
        filesDiv.appendChild(link);
        filesDiv.appendChild(document.createElement('br'));
      });
    }
  }
  // Status select
  const statusSel = document.getElementById('changeStatus');
  if(statusSel) statusSel.value = rec.status || 'Requested';
  window.saveChangeStatus = function(){
    const newStatus = document.getElementById('changeStatus').value;
    rec.status = newStatus;
    rec.history = rec.history || [];
    rec.history.push('Status updated to ' + newStatus);
    setStore('changes', changes);
    addAuditLog('Update Change Request', 'Change request ' + rec.no + ' status changed to ' + newStatus);
    updateBackendTasks();
    alert('Status saved.');
    location.reload();
  };
  // Actions list
  const listEl = document.getElementById('changeActionList');
  if(listEl){
    (rec.actions || []).forEach(a => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner || '-'}, Due: ${fmtD(a.due)}) — Status: ${a.status || 'Open'}`;
      listEl.appendChild(li);
    });
  }
  // Add action form
  const form = document.getElementById('changeActionForm');
  if(form){
    form.addEventListener('submit', e => {
      e.preventDefault();
      const a = {
        id: uid(),
        title: document.getElementById('chgActionTitle').value,
        owner: document.getElementById('chgActionOwner').value,
        dept: document.getElementById('chgActionDept').value,
        due: document.getElementById('chgActionDue').value,
        status: 'Open',
        source: 'Change',
        sourceRef: rec.no
      };
      rec.actions = rec.actions || [];
      rec.actions.push(a);
      rec.history = rec.history || [];
      rec.history.push('Action added: ' + a.title);
      let actionsStore = getStore('actions');
      actionsStore.push({ ...a });
      setStore('actions', actionsStore);
      setStore('changes', changes);
      addAuditLog('Add Change Action', 'Action ' + a.title + ' added to change request ' + rec.no);
      updateBackendTasks();
      location.reload();
    });
  }
  // History
  const hist = document.getElementById('changeHistory');
  if(hist){
    (rec.history || []).forEach(h => {
      let li = document.createElement('li');
      li.textContent = h;
      hist.appendChild(li);
    });
  }
  // Default tab
  const first = document.querySelector('.tablink');
  if(first) first.click();
});

// ====== Code generators for new modules ======
function nextPermitNo(id){ const y=(new Date()).getFullYear(); return `PTW-${y}-${String(id).slice(-5)}`; }
function nextSafetyNo(id){ const y=(new Date()).getFullYear(); return `SAF-${y}-${String(id).slice(-5)}`; }
function nextSdsNo(id){ const y=(new Date()).getFullYear(); return `SDS-${y}-${String(id).slice(-5)}`; }
function nextTrainingNo(id){ const y=(new Date()).getFullYear(); return `TRN-${y}-${String(id).slice(-5)}`; }

// Helper to generate a status badge span for complaint statuses. The CSS defines
// colours for each status class (e.g. status-new, status-in-review, etc.).
function badgeStatus(status){
  const cls = 'badge status-' + (status||'').toLowerCase().replace(/\s+/g, '-');
  return `<span class="${cls}">${status}</span>`;
}

// ====== Deletion helpers ======
// These helpers centralise removal of records across the different modules. They
// include confirmation prompts and cascade removal to related collections when
// appropriate.
function deleteComplaint(id){
  // Only admins can delete complaints
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Are you sure you want to permanently delete this complaint?')) return;
  const all = getStore('complaints');
  const record = findById(all, id);
  let complaints = all.filter(c=>String(c.id) !== String(id));
  // Remove associated CAPAs from global actions store based on sourceRef (ccNo)
  let actions = getStore('actions');
  if(record && record.ccNo){ actions = actions.filter(a=> !(a.source === 'Complaint' && a.sourceRef === record.ccNo)); }
  setStore('actions', actions);
  setStore('complaints', complaints);
  // Record audit log capturing before/after.  Only include before snapshot.
  addAuditLog('Delete Complaint', 'Complaint with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Customer Complaints' });
  // Sync tasks to backend
  updateBackendTasks();
  location.reload();
}
function deleteAction(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Are you sure you want to delete this action?')) return;
  let allActions = getStore('actions') || [];
  const record = findById(allActions, id);
  let actions = allActions.filter(a=>String(a.id) !== String(id));
  setStore('actions', actions);
  // Record audit log capturing before snapshot
  addAuditLog('Delete Action', 'Action with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Action Management' });
  // Sync tasks to backend
  updateBackendTasks();
  // Cascade remove from complaints CAPAs
  let complaints = getStore('complaints');
  let updatedC = false;
  complaints.forEach(c=>{
    if(c.capas){ const before = c.capas.length; c.capas = c.capas.filter(cap=>String(cap.id) !== String(id)); if(c.capas.length !== before) updatedC=true; }
  });
  if(updatedC) setStore('complaints', complaints);
  // Cascade remove from MOM actions
  let mom = getStore('mom');
  let updatedM = false;
  mom.forEach(m=>{
    if(m.actions){ const before = m.actions.length; m.actions = m.actions.filter(act=>String(act.id) !== String(id)); if(m.actions.length !== before) updatedM=true; }
  });
  if(updatedM) setStore('mom', mom);
  location.reload();
}
function deleteAudit(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Delete this audit schedule?')) return;
  const allAudits = getStore('audits') || [];
  const record = findById(allAudits, id);
  const audits = allAudits.filter(a=>String(a.id) !== String(id));
  // Remove any associated actions with sourceRef referencing this audit
  let actions = getStore('actions').filter(a=>!(a.source === 'Audit' && (a.sourceRef||'').startsWith('AUD-'+id)));
  setStore('audits', audits);
  setStore('actions', actions);
  // Audit log capturing deletion
  addAuditLog('Delete Audit', 'Audit schedule ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Internal Audits' });
  location.reload();
}
function deleteMom(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Delete this meeting and its actions?')) return;
  let mom = getStore('mom') || [];
  const m = findById(mom, id);
  mom = mom.filter(item=>String(item.id) !== String(id));
  // Remove associated actions from global store
  let actions = getStore('actions');
  if(m && m.no){ actions = actions.filter(a=> !(a.source === 'MOM' && a.sourceRef === m.no)); }
  setStore('actions', actions);
  setStore('mom', mom);
  addAuditLog('Delete MOM', 'Meeting with ID ' + id + ' deleted', { entity: id, before: m, after: null, module: 'MOM' });
  location.reload();
}
function deleteMomAction(momId, actionId){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Delete this MOM action?')) return;
  let mom = getStore('mom') || [];
  const m = findById(mom, momId);
  let deletedAction = null;
  if (m && Array.isArray(m.actions)) {
    const idx = m.actions.findIndex(a => String(a.id) === String(actionId));
    if (idx > -1) {
      deletedAction = m.actions[idx];
      m.actions.splice(idx, 1);
    }
  }
  setStore('mom', mom);
  // Remove from global actions list as well
  let allActions = getStore('actions') || [];
  const gRecord = findById(allActions, actionId);
  let actions = allActions.filter(a => String(a.id) !== String(actionId));
  setStore('actions', actions);
  // Audit log for removal of MOM action
  addAuditLog('Delete MOM Action', 'Removed action ' + actionId + ' from meeting ' + momId, { entity: actionId, before: gRecord, after: null, module: 'MOM' });
  location.reload();
}

// ====== Deletion helpers for new modules ======
function deletePermit(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Are you sure you want to permanently delete this permit?')) return;
  let permits = getStore('permits') || [];
  const record = findById(permits, id);
  permits = permits.filter(p=>String(p.id) !== String(id));
  // Cascade remove associated actions
  let actions = getStore('actions');
  if(record && record.no){ actions = actions.filter(a=> !(a.source === 'Permit' && a.sourceRef === record.no)); }
  setStore('actions', actions);
  setStore('permits', permits);
  // audit log for permit deletion
  addAuditLog('Delete Permit', 'Permit with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Permit to Work' });
  location.reload();
}
function deleteSafety(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Are you sure you want to delete this safety issue?')) return;
  let safety = getStore('safety') || [];
  const record = findById(safety, id);
  safety = safety.filter(s=>String(s.id) !== String(id));
  let actions = getStore('actions');
  if(record && record.no){ actions = actions.filter(a=> !(a.source === 'Safety' && a.sourceRef === record.no)); }
  setStore('actions', actions);
  setStore('safety', safety);
  addAuditLog('Delete Safety Issue', 'Safety record with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Safety Issues' });
  location.reload();
}
function deleteSds(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Delete this SDS record?')) return;
  let sds = getStore('sds') || [];
  const record = findById(sds, id);
  sds = sds.filter(x=>String(x.id) !== String(id));
  let actions = getStore('actions');
  if(record && record.no){ actions = actions.filter(a=> !(a.source === 'SDS' && a.sourceRef === record.no)); }
  setStore('actions', actions);
  setStore('sds', sds);
  addAuditLog('Delete SDS', 'SDS record with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'SDS' });
  location.reload();
}
function deleteTraining(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Delete this training record?')) return;
  let training = getStore('training') || [];
  const record = findById(training, id);
  training = training.filter(t=>String(t.id) !== String(id));
  let actions = getStore('actions');
  if(record && record.no){ actions = actions.filter(a=> !(a.source === 'Training' && a.sourceRef === record.no)); }
  setStore('actions', actions);
  setStore('training', training);
  addAuditLog('Delete Training', 'Training record with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Training' });
  location.reload();
}

// Delete an employee from the directory. When an employee is deleted they are removed from
// any training records where they were listed as a participant. Training sessions will
// remain, but the employee will no longer be associated. This preserves historical
// training data for other participants.
function deleteEmployee(id){
  if (!isAdmin()) {
    alert('Insufficient privileges to delete this item.');
    return;
  }
  if (!confirm('Are you sure you want to delete this employee?')) return;
  let employees = getStore('employees') || [];
  const record = findById(employees, id);
  employees = employees.filter(e=>String(e.id) !== String(id));
  setStore('employees', employees);
  // Record audit log capturing before snapshot
  addAuditLog('Delete Employee', 'Employee with ID ' + id + ' deleted', { entity: id, before: record, after: null, module: 'Employees' });
  // Remove employee from training participants lists
  let training = getStore('training');
  let modified = false;
  training.forEach(t=>{
    // ensure participants is an array
    if(!Array.isArray(t.participants)){
      if(t.participants){ t.participants = [t.participants]; modified = true; }
      else { t.participants = []; }
    }
    const before = t.participants.length;
    t.participants = t.participants.filter(pid => String(pid) !== String(id));
    if(t.participants.length !== before) modified = true;
  });
  if(modified) setStore('training', training);
  // Sync tasks to backend (in case actions or complaints reference this employee)
  updateBackendTasks();
  location.reload();
}

// ====== Chart (simple canvas) ======
function barChart(canvasId, labels, values){
  const c = document.getElementById(canvasId);
  if(!c) return;
  const ctx = c.getContext('2d');
  const W=c.width, H=c.height;
  ctx.clearRect(0,0,W,H);
  ctx.font="12px sans-serif";
  const max = Math.max(1, ...values);
  const bw = Math.floor((W-40)/Math.max(values.length,1));
  // Draw grid lines for better readability
  const gridLines = 4;
  ctx.strokeStyle = '#e5e9f2';
  ctx.lineWidth = 1;
  for(let i=1;i<=gridLines;i++){
    const y = 20 + (H-40) * (i/(gridLines+1));
    ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(W-20, y); ctx.stroke();
    // draw y axis label
    const val = Math.round(max * (1 - i/(gridLines+1)));
    ctx.fillStyle = '#6b7280';
    ctx.fillText(val.toString(), 2, y+4);
  }
  // Define a colour palette based on primary/accent colours
  const colours = ['#3d6dbc','#4f7ed1','#608fe6','#729ff4','#86b1f7','#a1c3fa','#bdd4fc'];
  values.forEach((v,i)=>{
    const h = Math.round((H-40) * (v/max));
    const x = 20 + i*bw;
    const y = H-20 - h;
    ctx.fillStyle = colours[i % colours.length];
    ctx.fillRect(x, y, Math.floor(bw*0.6), h);
    ctx.fillStyle = '#233043';
    ctx.fillText(labels[i], x, H-6);
    ctx.fillText(String(v), x, y-4);
  });
}

// ====== Common defects per service ======
const DEFECTS = {
  "Hydro-jetting": ["Insufficient cleaning", "Surface damage", "Nozzle blockage", "Low pressure"],
  "Vacuum Truck": ["Incomplete suction", "Spillage during transfer", "Delay in arrival", "Hose leakage"],
  "Hazardous Waste": ["Incorrect labeling", "Improper segregation", "Late pickup", "Manifest error"],
  "Tank Cleaning": ["Residue left in tank", "Confined space safety breach", "Incomplete gas-free certificate"],
  "Sewer Line": ["Blockage reoccurred", "Backflow after service", "Odor persists"],
  "Catalyst Handling": ["Dust escape", "Loss of material", "Contamination risk"],
  "Bundle Pulling": ["Bundle damage", "Alignment issue", "Delay in reinstatement"],
  "Other": ["General dissatisfaction", "Unclear scope", "Billing dispute"]
};

// ====== Stage gating ======
const STAGES = ["overview","triage","investigation","actions","effectiveness","evidence","communication","history"];
function allowedStagesByStatus(status){
  switch(status){
    case "New": return ["overview","triage","history"];
    case "In Review": return ["overview","triage","investigation","evidence","communication","history"];
    case "Under Investigation": return ["overview","investigation","actions","evidence","communication","history"];
    case "Actioning": return ["overview","actions","evidence","communication","history"];
    case "Verifying": return ["overview","effectiveness","evidence","communication","history"];
    case "Closed": return STAGES;
    default: return ["overview","history"];
  }
}
function gateTabs(status){
  const allowed = allowedStagesByStatus(status);
  document.querySelectorAll('.tablink').forEach(btn=>{
    const stage = btn.getAttribute('data-stage')||btn.getAttribute('onclick')||'';
    const key = btn.getAttribute('data-stage') || (btn.textContent.toLowerCase().includes('overview')?'overview':'history');
    if(allowed.includes(key)) btn.classList.remove('disabled');
    else btn.classList.add('disabled');
  });
}
function openTab(evt, tabName){
  if(evt && evt.currentTarget && evt.currentTarget.classList.contains('disabled')) return;
  let contents = document.getElementsByClassName('tabcontent');
  for(let i=0;i<contents.length;i++){ contents[i].style.display='none'; }
  let tabs = document.getElementsByClassName('tablink');
  for(let i=0;i<tabs.length;i++){ tabs[i].style.background=''; }
  const el = document.getElementById(tabName);
  if(el) el.style.display='block';
  if(evt && evt.currentTarget) evt.currentTarget.style.background='#d8deea';
}

// ====== Dashboard ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(document.getElementById('cmpStatusChart')){
    const complaints = getStore('complaints');
    const actions = getStore('actions');
    const audits = getStore('audits');

      // Training records
      const training = getStore('training') || [];
      // Safety issues
      const safety = getStore('safety') || [];

    // Complaints by status
    const cStatuses = ["New","In Review","Under Investigation","Actioning","Verifying","Closed"];
    const cVals = cStatuses.map(s => complaints.filter(c=>c.status===s).length);
    barChart('cmpStatusChart', ["New","Rev","Inv","Act","Ver","Cls"], cVals);

    // Actions by status
    const aStatuses = ["Open","In Progress","Pending Verification","Verified Closed"];
    const aVals = aStatuses.map(s => actions.filter(a=>a.status===s).length);
    barChart('actStatusChart', ["Open","Prog","Pend","Done"], aVals);

    // Services bar
    const svcCounts = {}; complaints.forEach(c=>{ svcCounts[c.service] = (svcCounts[c.service]||0)+1; });
    const svcLabels = Object.keys(svcCounts).slice(0,7);
    const svcVals = svcLabels.map(k=>svcCounts[k]);
    barChart('svcBar', svcLabels, svcVals);

    // SLA Breaches
    const breaches = complaints.filter(c=>c.slaDate && c.status!=="Closed" && c.slaDate < today()).length;
    document.getElementById('slaBreachCount').textContent = String(breaches);

    // Open CAPAs
    const openCapas = complaints.reduce((acc,c)=> acc + (c.capas||[]).filter(a=>a.status!=="Verified Closed").length, 0);
    document.getElementById('openCapas').textContent = String(openCapas);

    // Audits planned this month
    const now = new Date();
    const ym = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
    const planned = audits.filter(a=> (a.date||'').startsWith(ym));
    document.getElementById('auditsPlanned').textContent = String(planned.length);

      // Training by status (Scheduled, Completed, Overdue)
      if(document.getElementById('trainingStatusChart')){
        const tStatuses = ['Scheduled','Completed','Overdue'];
        const tVals = tStatuses.map(s => training.filter(t => (t.status||'') === s).length);
        barChart('trainingStatusChart', ['Sch','Comp','Over'], tVals);
      }
      // Safety issues by status (New, Investigating, Actioning, Closed)
      if(document.getElementById('safetyStatusChart')){
        const sStatuses = ['New','Investigating','Actioning','Closed'];
        const sVals = sStatuses.map(s => safety.filter(i => (i.status||'') === s).length);
        barChart('safetyStatusChart', ['New','Inv','Act','Cls'], sVals);
      }
      // Audits by status (Planned, In Progress, Completed)
      if(document.getElementById('auditStatusChart')){
        const audStatuses = ['Planned','In Progress','Completed'];
        const audVals = audStatuses.map(s => audits.filter(a => (a.status||'') === s).length);
        barChart('auditStatusChart', ['Plan','Prog','Comp'], audVals);
      }

      // Training compliance (employees who have completed all required courses versus those missing requirements)
      if(document.getElementById('trainingComplianceChart')){
        // Load employees and training sessions
        const employees = getStore('employees') || [];
        const sessions = training || [];
        // Load role-course mapping
        let courseReqs = {};
        try {
          courseReqs = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
        } catch (e) { courseReqs = {}; }
        if(Object.keys(courseReqs).length === 0){ courseReqs = Object.assign({}, DEFAULT_ROLE_COURSE_REQS); }
        let compliantCount = 0;
        employees.forEach(emp => {
          const required = Array.isArray(courseReqs[emp.role]) ? courseReqs[emp.role] : [];
          if(!required || required.length === 0){
            // no requirements = automatically compliant
            compliantCount++;
            return;
          }
          // Determine completed courses for this employee
          const completed = new Set();
          sessions.forEach(s => {
            let participants = [];
            if(Array.isArray(s.participants)) participants = s.participants;
            else if(s.participants) participants = [s.participants];
            if(participants.map(String).includes(String(emp.id)) && s.status === 'Completed' && s.title){
              completed.add(s.title);
            }
          });
          const allDone = required.every(course => completed.has(course));
          if(allDone) compliantCount++;
        });
        const nonCompliant = employees.length - compliantCount;
        barChart('trainingComplianceChart', ['Full','Missing'], [compliantCount, nonCompliant]);
      }

    // Populate the list of pending tasks for the current user.  This now includes not only
    // Action Management items but also upcoming training sessions assigned to the logged in
    // user.  Additional task types can be added here in the future (e.g. audit duties).
    const tasksListEl = document.getElementById('myTasksList');
    if(tasksListEl){
      const current = getCurrentUser();
      const aggregated = [];
      // Retrieve actions and filter by ownerId matching the current user
      let myActs = getStore('actions') || [];
      myActs = myActs.filter(a => {
        if(!a.ownerId || !current) return false;
        const allowed = [String(current.id)];
        if(current.employeeId) allowed.push(String(current.employeeId));
        const idPart = String(a.ownerId).replace(/^usr-|^emp-/, '');
        return a.status !== 'Verified Closed' && allowed.includes(String(idPart));
      });
      // Convert action tasks into a common format and mark type
      myActs.forEach(a => {
        aggregated.push(Object.assign({}, a, { type: 'action' }));
      });
      // Add training tasks for the current employee
      const sessions = getStore('training') || [];
      if(current && current.employeeId){
        sessions.forEach(sess => {
          let parts = [];
          if(Array.isArray(sess.participants)) parts = sess.participants;
          else if(sess.participants) parts = [sess.participants];
          const includes = parts.map(String).includes(String(current.employeeId));
          const status = (sess.status || '').toLowerCase();
          if(includes && status !== 'completed' && status !== 'cancelled'){
            aggregated.push({
              id: sess.id,
              title: sess.title || '(Training)',
              source: 'Training',
              due: sess.date || '',
              status: sess.status || '',
              type: 'training'
            });
          }
        });
      }
      // Sort tasks by due date (earliest first)
      aggregated.sort((a,b)=>{
        const d1 = a.due ? new Date(a.due).getTime() : Infinity;
        const d2 = b.due ? new Date(b.due).getTime() : Infinity;
        return d1 - d2;
      });
      tasksListEl.innerHTML = '';
      if(aggregated.length === 0){
        const li = document.createElement('li');
        li.textContent = 'No pending tasks.';
        tasksListEl.appendChild(li);
      } else {
        aggregated.forEach(t => {
          const li = document.createElement('li');
          const due = t.due ? t.due : '-';
          li.innerHTML = `<b>${t.title}</b> (${t.source || 'Action'}) – Due: ${due} – Status: ${t.status || ''}`;
          // Only Action items have inline controls
          if(t.type === 'action'){
            const a = t;
            const btnWrap = document.createElement('div');
            btnWrap.style.marginTop = '4px';
            let editable = canEdit();
            if(!editable && current){
              const allowed = [String(current.id)];
              if(current.employeeId) allowed.push(String(current.employeeId));
              const idPart = String(a.ownerId || '').replace(/^usr-|^emp-/, '');
              editable = allowed.includes(idPart);
            }
            // Inline controls for action tasks
            // Only the action owner (editable) can progress or mark their task completed.  When
            // marking completed, the status is always set to Pending Verification; QA will
            // subsequently verify and close the action.  Verification controls are only
            // displayed to users with QA privileges (canVerify()).
            if(editable){
              if(a.status === 'Open' || a.status === 'In Progress'){
                const progBtn = document.createElement('button');
                progBtn.textContent = 'Start/Progress';
                progBtn.onclick = () => {
                  update(a.id, { status: 'In Progress' });
                  window.location.reload();
                };
                btnWrap.appendChild(progBtn);
                const compBtn = document.createElement('button');
                compBtn.textContent = 'Mark Completed';
                compBtn.onclick = () => {
                  // Always transition to Pending Verification on completion.  QA users
                  // will handle final verification separately.
                  const comment = prompt('Add comments (optional):', '') || '';
                  update(a.id, { status: 'Pending Verification', qaEvidence: comment || 'Completed via dashboard' });
                  window.location.reload();
                };
                btnWrap.appendChild(compBtn);
              }
            }
            // QA verification controls – show only if the action is pending verification and
            // the current user is in a QA role
            if(a.status === 'Pending Verification' && canVerify()){
              const inp = document.createElement('input');
              inp.placeholder = 'QA evidence note';
              inp.style.marginRight = '6px';
              const verBtn = document.createElement('button');
              verBtn.textContent = 'Verify & Close';
              verBtn.onclick = () => {
                update(a.id, { status: 'Verified Closed', qaEvidence: inp.value || 'Verified via dashboard' });
                window.location.reload();
              };
              btnWrap.appendChild(inp);
              btnWrap.appendChild(verBtn);
            }
            if(btnWrap.children.length > 0) li.appendChild(btnWrap);
          }
          tasksListEl.appendChild(li);
        });
      }
    }
  }
});

// ====== Complaints page ======
document.addEventListener('DOMContentLoaded', ()=>{
  // Populate defects based on service
  const svc = document.getElementById('service');
  const defect = document.getElementById('commonDefect');
  if(svc && defect){
    function fill(){ defect.innerHTML = '<option value=\"\">-- Select --</option>'; (DEFECTS[svc.value]||[]).forEach(d=>{ const o=document.createElement('option'); o.value=d; o.textContent=d; defect.appendChild(o); }); }
    svc.addEventListener('change', fill); fill();
  }

  // Intake submit
  const form = document.getElementById('complaintForm');
  if(form){
    // Populate assignee select with employees
    if(document.getElementById('complaintAssignee')){
      populateEmployeeSelect('complaintAssignee', true);
    }
    form.addEventListener('submit', e=>{
      e.preventDefault();
      let complaints = getStore('complaints');
      const id = uid();
      const rec = {
        id,
        ccNo: nextCCNo(id),
        createdAt: new Date().toISOString(),
        customer: document.getElementById('customer').value,
        customerCode: document.getElementById('customerCode').value,
        site: document.getElementById('site').value,
        contact: document.getElementById('contact').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        service: document.getElementById('service').value,
        job: document.getElementById('job').value,
        contract: document.getElementById('contract').value,
        incidentDT: document.getElementById('incidentDT').value,
        reportedBy: document.getElementById('reportedBy').value,
        channel: document.getElementById('channel').value,
        title: document.getElementById('title').value,
        problemType: document.getElementById('problemType').value,
        commonDefect: document.getElementById('commonDefect').value,
        description: document.getElementById('description').value,
        asset: document.getElementById('asset').value,
        geo: document.getElementById('geo').value,
        impactPeople: document.getElementById('impactPeople').value,
        impactEnv: document.getElementById('impactEnv').value,
        impactCust: document.getElementById('impactCust').value,
        impactCost: document.getElementById('impactCost').value,
        containment: document.getElementById('containment').value,
        containmentDesc: document.getElementById('containmentDesc').value,
        severity: '',
        priority: '',
        slaDate: '',
        ownerDept: '',
        responsible: '',
        visibility: 'Internal',
        whys: [],
        fishbone: [],
        rootCause: '',
        contribCauses: '',
        verifyCause: '',
        evidence: [],
        comms: [],
        capas: [],
        // Assignment fields
        assignedTo: (function () {
          const sel = document.getElementById('complaintAssignee');
          return sel ? sel.value : '';
        })(),
        assignedName: '',
        assignedEmail: '',
        dueDate: (function () {
          const dt = document.getElementById('complaintDue');
          return dt ? dt.value : '';
        })(),
        reminderDays: (function () {
          const r = document.getElementById('complaintReminder');
          const val = r ? r.value : '';
          const parsed = parseInt(val);
          if (!isNaN(parsed)) return parsed;
          const def = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
          return def.reminderDays || 0;
        })(),
        status: 'New',
        history: ['Created complaint']
      };
      // Resolve assigned name and email based on prefix (employee or user)
      if (rec.assignedTo) {
        if (rec.assignedTo.startsWith('emp-')) {
          const empId = rec.assignedTo.slice(4);
          const employees = getStore('employees') || [];
          const emp = employees.find(e => String(e.id) === String(empId));
          if (emp) {
            rec.assignedName = emp.name || '';
            rec.assignedEmail = emp.email || '';
          }
        } else if (rec.assignedTo.startsWith('usr-')) {
          const userId = rec.assignedTo.slice(4);
          const users = getStore('users') || [];
          const user = users.find(u => String(u.id) === String(userId));
          if (user) {
            rec.assignedName = user.username + (user.role ? ' (' + user.role + ')' : '');
            rec.assignedEmail = user.email || '';
          }
        }
      }
      complaints.push(rec);
      setStore('complaints', complaints);
      // Notify assigned user if email exists
      if (rec.assignedEmail) {
        const subject = `Complaint Assigned: ${rec.title}`;
        const body = `You have been assigned to complaint ${rec.ccNo}: ${rec.title}. Please log in to review details.`;
        sendEmail(rec.assignedEmail, subject, body);
      }
      // Record audit log for new complaint
      addAuditLog('Create Complaint', 'Complaint ' + rec.ccNo + ' created');
      // Sync tasks to backend for reminders
      updateBackendTasks();
      location.reload();
    });

    // Table
    const table = document.getElementById('complaintTable');
    const list = getStore('complaints');
    list.forEach(c=>{
      let r = table.insertRow();
      r.insertCell(0).innerText = c.ccNo;
      r.insertCell(1).innerText = c.title;
      r.insertCell(2).innerText = c.customer;
      r.insertCell(3).innerText = c.service;
      r.insertCell(4).innerText = c.assignedName || '-';
      r.insertCell(5).innerText = c.severity || '';
      // Status with coloured badge; include SLA indicator if overdue
      const statusCell = r.insertCell(6);
      statusCell.innerHTML = badgeStatus(c.status) + (c.slaDate && c.status !== 'Closed' && c.slaDate < today() ? ' <span class="badge overdue">SLA</span>' : '');
      // Manage button
      const actionCell = r.insertCell(7);
      const manageBtn = document.createElement('button');
      manageBtn.textContent = 'View/Manage';
      manageBtn.onclick = () => { window.location = 'complaint_detail.html?id=' + c.id; };
      actionCell.appendChild(manageBtn);
      // Delete button
      const delCell = r.insertCell(8);
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.style.background = '#c73636';
      delBtn.onclick = () => deleteComplaint(c.id);
      delCell.appendChild(delBtn);
    });
    // Setup search/filter and export for complaints list
    setupListPage('searchComplaints','exportComplaints','complaintTable','complaints');

    // Handle complaint import from CSV
    const impBtn = document.getElementById('importComplaintsBtn');
    if(impBtn){
      impBtn.addEventListener('click', async ()=>{
        const fileInput = document.getElementById('complaintImportFile');
        if(!fileInput || !fileInput.files || fileInput.files.length === 0){
          alert('Please select a CSV file to import');
          return;
        }
        const file = fileInput.files[0];
        try{
          const text = await file.text();
          const lines = text.trim().split(/\r?\n/);
          if(lines.length <= 1){
            alert('CSV file appears to be empty');
            return;
          }
          const header = lines[0].split(',');
          const idx = (name) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
          const idxTitle = idx('title') >= 0 ? idx('title') : 0;
          const idxCust = idx('customer');
          const idxService = idx('service');
          const idxDesc = idx('description');
          const idxAssigned = idx('assigned') >= 0 ? idx('assigned') : idx('assignee');
          const idxDue = (()=>{ const i1 = idx('due'); if(i1 >= 0) return i1; const i2 = idx('duedate'); return i2; })();
          const idxSeverity = idx('severity');
          let complaints = getStore('complaints') || [];
          const employees = getStore('employees') || [];
          const users = getStore('users') || [];
          let imported = 0;
          for(let i=1; i<lines.length; i++){
            const cols = lines[i].split(',');
            if(cols.every(c => c.trim() === '')) continue;
            const id = uid();
            const title = cols[idxTitle] || cols[0] || '';
            const customer = (idxCust >= 0 ? cols[idxCust] : '') || '';
            const service = (idxService >= 0 ? cols[idxService] : '') || '';
            const description = (idxDesc >= 0 ? cols[idxDesc] : '') || '';
            const assignedVal = (idxAssigned >= 0 ? cols[idxAssigned] : '') || '';
            // Determine assignedTo id string based on name or id
            let assignedTo = '';
            let assignedName = '';
            let assignedEmail = '';
            if(assignedVal){
              const emp = employees.find(e => {
                return (e.name && e.name.trim().toLowerCase() === assignedVal.trim().toLowerCase()) ||
                       (String(e.empId) === String(assignedVal)) ||
                       (String(e.id) === String(assignedVal));
              });
              if(emp){
                assignedTo = 'emp-' + emp.id;
                assignedName = emp.name || '';
                assignedEmail = emp.email || '';
              } else {
                const user = users.find(u => {
                  return (u.username && u.username.trim().toLowerCase() === assignedVal.trim().toLowerCase()) ||
                         (u.email && u.email.trim().toLowerCase() === assignedVal.trim().toLowerCase()) ||
                         (String(u.id) === String(assignedVal));
                });
                if(user){
                  assignedTo = 'usr-' + user.id;
                  assignedName = user.username + (user.role ? ' (' + user.role + ')' : '');
                  assignedEmail = user.email || '';
                }
              }
            }
            const dueDate = (idxDue >= 0 ? cols[idxDue] : '') || '';
            const severity = (idxSeverity >= 0 ? cols[idxSeverity] : '') || '';
            const rec = {
              id: id,
              ccNo: nextCCNo(id),
              createdAt: new Date().toISOString(),
              customer: customer,
              customerCode: '',
              site: '',
              contact: '',
              email: '',
              phone: '',
              service: service,
              job: '',
              contract: '',
              incidentDT: '',
              reportedBy: '',
              channel: '',
              title: title,
              problemType: '',
              commonDefect: '',
              description: description,
              asset: '',
              geo: '',
              impactPeople: '',
              impactEnv: '',
              impactCust: '',
              impactCost: '',
              containment: '',
              containmentDesc: '',
              severity: severity,
              priority: '',
              slaDate: '',
              ownerDept: '',
              responsible: '',
              visibility: 'Internal',
              whys: [],
              fishbone: [],
              rootCause: '',
              contribCauses: '',
              verifyCause: '',
              evidence: [],
              comms: [],
              capas: [],
              assignedTo: assignedTo,
              assignedName: assignedName,
              assignedEmail: assignedEmail,
              dueDate: dueDate,
              reminderDays: (function(){
                const def = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
                return def.reminderDays || 0;
              })(),
              status: 'New',
              history: ['Imported from CSV']
            };
            complaints.push(rec);
            imported++;
          }
          if(imported > 0){
            setStore('complaints', complaints);
            addAuditLog('Import Complaints', `${imported} complaints imported from CSV`);
            // Notify assigned users
            complaints.slice(complaints.length - imported).forEach(rec=>{
              if(rec.assignedEmail){
                const subject = `Complaint Assigned: ${rec.title}`;
                const body = `You have been assigned to complaint ${rec.ccNo}: ${rec.title}. Please log in to review details.`;
                sendEmail(rec.assignedEmail, subject, body);
              }
            });
            // Sync tasks to backend for reminders
            updateBackendTasks();
            alert(`Imported ${imported} complaints.`);
            location.reload();
          } else {
            alert('No valid complaint rows found to import.');
          }
        }catch(err){
          console.error(err);
          alert('Error importing complaints: ' + err.message);
        }
      });
    }
  }
});

// ====== Complaint Detail ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('complaint_detail.html')) return;
  const params = new URLSearchParams(window.location.search); const id = params.get('id');
  let complaints = getStore('complaints'); let c = findById(complaints, id);
  if(!c){ document.getElementById('complaintDetailContainer').innerHTML='<p>Complaint not found.</p>'; return; }

  // Header & status: include assignment and due date information if available
  document.getElementById('headerCard').innerHTML = `<b>${c.ccNo}</b> — <b>${c.title}</b><br>
    Customer: ${c.customer} | Service: ${c.service} | Created: ${fmtDT(c.createdAt)}<br>
    Assigned To: ${c.assignedName || '-'} | Due: ${c.dueDate ? fmtD(c.dueDate) : '-'} | Reminder: ${typeof c.reminderDays !== 'undefined' ? c.reminderDays + 'd' : '-'}`;
  document.getElementById('statusBar').innerHTML = 'Status: ' + badgeStatus(c.status);
  gateTabs(c.status);

  // Overview
  document.getElementById('overviewContent').innerHTML = `
    <div class="grid-2">
      <div class="card">
        <b>Header</b><br>
        Customer: ${c.customer} (${c.customerCode})<br>
        Site: ${c.site}<br>
        Contact: ${c.contact} | ${c.email} | ${c.phone}<br>
        Service: ${c.service} | SO/Job: ${c.job} | Contract: ${c.contract}<br>
        Incident: ${fmtDT(c.incidentDT)} | Reported By: ${c.reportedBy} | Channel: ${c.channel}
      </div>
      <div class="card">
        <b>Issue</b><br>
        Type: ${c.problemType}<br>
        Common Defect: ${c.commonDefect || '-'}<br>
        Description: ${c.description || ''}<br>
        Asset: ${c.asset} | Geo: ${c.geo}<br>
        Containment: ${c.containment}${c.containment==='Yes' ? (' — '+(c.containmentDesc||'')) : ''}
      </div>
    </div>
    <div class="card"><b>Initial Impact</b><br>
      People/Safety: ${c.impactPeople || '-'} | Environment: ${c.impactEnv || '-'} | Customer: ${c.impactCust || '-'} | Cost: ${c.impactCost || '-'}
    </div>`;
  document.getElementById('internalNotes').value = c.internalNotes || '';

  // Triage defaults + automation
  const sev = document.getElementById('severity'); const pri = document.getElementById('priority'); const sla = document.getElementById('slaDate');
  document.getElementById('ownerDept').value = c.ownerDept || ''; document.getElementById('responsible').value = c.responsible || ''; document.getElementById('visibility').value = c.visibility || 'Internal';
  sev.value = c.severity || 'Major'; pri.value = c.priority || 'P2'; if(c.slaDate) sla.value = c.slaDate;
  sev.addEventListener('change', ()=>{
    if(sev.value==='Critical'){ pri.value='P1'; sla.value = addDays(2); }
    else if(sev.value==='Major'){ pri.value='P2'; sla.value = addDays(5); }
    else { pri.value='P3'; sla.value = addDays(10); }
  });

  // Investigation defaults
  document.getElementById('whys').value = (c.whys||[]).join('\\n');
  (c.fishbone||[]).forEach(tag=>{ const cb = Array.from(document.getElementsByClassName('fishbone')).find(x=>x.value===tag); if(cb) cb.checked = true; });
  document.getElementById('rootCause').value = c.rootCause || '';
  document.getElementById('contribCauses').value = c.contribCauses || '';
  document.getElementById('verifyCause').value = c.verifyCause || '';

  // Evidence
  const evList = document.getElementById('evidenceList');
  (c.evidence||[]).forEach(name=>{ let li=document.createElement('li'); li.textContent=name; evList.appendChild(li); });
  const evUpload = document.getElementById('evidenceUpload');
  evUpload.addEventListener('change', ()=>{
    let names = Array.from(evUpload.files).map(f=>f.name);
    c.evidence = (c.evidence||[]).concat(names); c.history.push(`Added evidence: ${names.join(', ')}`); setStore('complaints', complaints); location.reload();
  });

  // Communication
  const commList = document.getElementById('commList');
  (c.comms||[]).forEach(cm=>{ let li=document.createElement('li'); li.textContent = `[${fmtDT(cm.date)}] To: ${cm.to} | ${cm.subject} — ${cm.body}`; commList.appendChild(li); });
  document.getElementById('commForm').addEventListener('submit', e=>{
    e.preventDefault(); let cm={date:new Date().toISOString(), to:commTo.value, subject:commSubject.value, body:commBody.value};
    c.comms = (c.comms||[]); c.comms.push(cm); c.history.push('Logged communication to '+cm.to); setStore('complaints', complaints); location.reload();
  });

  // History
  const hist = document.getElementById('historyList'); (c.history||[]).forEach(h=>{ let li=document.createElement('li'); li.textContent=h; hist.appendChild(li); });

  // CAPAs
  const capaUL = document.getElementById('capaList');
  (c.capas||[]).forEach(a=>{ let li=document.createElement('li'); li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner||'-'}, Due: ${a.due||'-'}) — Status: ${a.status||'Open'}`; capaUL.appendChild(li); });
  // Populate CAPA owner select
  if(document.getElementById('capaOwner')){
    populateAssigneeSelect('capaOwner', true);
  }
  document.getElementById('capaForm').addEventListener('submit', e=>{
    e.preventDefault();
    // Determine selected owner
    const selected = document.getElementById('capaOwner') ? document.getElementById('capaOwner').value : '';
    let ownerName = '';
    let ownerEmail = '';
    let ownerId = selected;
    if(selected){
      if(selected.startsWith('emp-')){
        const idPart = selected.slice(4);
        const employees = getStore('employees') || [];
        const emp = employees.find(e => String(e.id) === String(idPart));
        if(emp){ ownerName = emp.name || ''; ownerEmail = emp.email || ''; }
      } else if(selected.startsWith('usr-')){
        const idPart = selected.slice(4);
        const users = getStore('users') || [];
        const user = users.find(u => String(u.id) === String(idPart));
        if(user){ ownerName = user.username + (user.role ? ' (' + user.role + ')' : ''); ownerEmail = user.email || ''; }
      }
    }
    const a = {
      id: uid(),
      title: capaTitle.value,
      ownerId,
      owner: ownerName || '',
      ownerEmail,
      dept: capaDept.value,
      due: capaDue.value,
      status: 'Open',
      source: 'Complaint',
      sourceRef: c.ccNo
    };
    c.capas = (c.capas || []);
    c.capas.push(a);
    c.status = 'Actioning';
    c.history.push('CAPA added: ' + a.title);
    let actions = getStore('actions');
    actions.push({ ...a });
    setStore('actions', actions);
    // Send notification to owner if email exists
    if(a.ownerEmail){
      const subj = `Action Assigned: ${a.title}`;
      const body = `You have been assigned a CAPA action for complaint ${c.ccNo}: ${a.title}. Due: ${a.due || 'TBD'}.`;
      sendEmail(a.ownerEmail, subj, body);
    }
    // Persist complaint updates
    setStore('complaints', complaints);
    // Audit log entry
    addAuditLog('Add CAPA', 'CAPA ' + a.title + ' added to complaint ' + c.ccNo);
    // Sync tasks to backend
    updateBackendTasks();
    location.reload();
  });

  // Save + transitions
  window.saveNotes = function(){ c.internalNotes = internalNotes.value; c.history.push('Saved internal notes'); setStore('complaints', complaints); alert('Notes saved.'); };
  window.saveTriage = function(){
    // Persist triage fields
    c.severity = severity.value;
    c.priority = priority.value;
    c.slaDate = slaDate.value;
    c.ownerDept = ownerDept.value;
    c.responsible = responsible.value;
    c.visibility = visibility.value;
    c.status = 'In Review';
    c.history.push('Triage saved');
    // High severity escalation: If the complaint is marked Critical (or P1) send notification and audit log
    if (c.severity === 'Critical' || c.priority === 'P1') {
      try {
        // Determine recipients: all admin emails or fallback to configured fromEmail
        const users = getStore('users') || [];
        const admins = users.filter(u => u.role === 'admin');
        const adminEmails = admins.map(u => u.email).filter(Boolean);
        const settings = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
        const recipients = adminEmails.length > 0 ? adminEmails.join(',') : (settings.fromEmail || '');
        const subject = `High Severity Complaint: ${c.ccNo}`;
        const body = `Complaint ${c.ccNo} has been triaged as severity ${c.severity} with priority ${c.priority}. Please investigate immediately.`;
        if (recipients) {
          sendEmail(recipients, subject, body);
        }
        addAuditLog('High Severity Complaint', `Complaint ${c.ccNo} triaged as ${c.severity}`, { entity: c.id, module: 'Customer Complaints' });
      } catch (e) {
        console.warn('High severity escalation failed', e);
      }
    }
    setStore('complaints', complaints);
    location.reload();
  };
  window.saveInvestigation = function(){
    c.whys = (whys.value||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(0,5);
    c.fishbone = Array.from(document.getElementsByClassName('fishbone')).filter(x=>x.checked).map(x=>x.value);
    c.rootCause = rootCause.value; c.contribCauses = contribCauses.value; c.verifyCause=verifyCause.value;
    c.status='Under Investigation'; c.history.push('Investigation saved'); setStore('complaints', complaints); location.reload();
  };
  window.markVerifying = function(){ c.status='Verifying'; c.history.push('Moved to Verifying'); setStore('complaints', complaints); location.reload(); };
  window.closeComplaint = function(){
    // Ensure all CAPAs verified before closure
    const haveCapas = (c.capas||[]).length>0;
    const allVerified = (c.capas||[]).every(a=>a.status==='Verified Closed');
    if(haveCapas && !allVerified){ alert('All CAPA actions must be Verified Closed before final closure.'); return; }
    c.effectiveness = effective.value; c.effectivenessNotes = effectivenessNotes.value;
    c.status = (effective.value==='Yes') ? 'Closed' : 'Actioning'; c.history.push('Effectiveness check: '+effective.value); if(effective.value==='Yes') c.history.push('Complaint Closed');
    setStore('complaints', complaints); location.reload();
  };
  window.generateReport = function(){ localStorage.setItem('reportComplaint', JSON.stringify(c)); window.location='closure_report.html'; };

  // Open first allowed tab
  const first = allowedStagesByStatus(c.status)[0]; const btn = document.querySelector(`.tablink[data-stage="${first}"]`) || document.querySelector('.tablink'); if(btn) btn.click();
});

// ====== Closure Report ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('closure_report.html')) return;
  const c = JSON.parse(localStorage.getItem('reportComplaint')||'{}'); if(!c.id) return;
  const el = document.getElementById('reportContent');
  el.innerHTML = `
    <b>${c.ccNo}</b><br>
    <b>Title:</b> ${c.title}<br>
    <b>Customer:</b> ${c.customer} (${c.customerCode||''}) — ${c.site||''}<br>
    <b>Service:</b> ${c.service} — <b>Status:</b> ${c.status}<br>
    <hr>
    <b>Description:</b> ${c.description||''}<br>
    <b>Containment:</b> ${c.containment}${c.containment==='Yes' ? (' — '+(c.containmentDesc||'')) : ''}<br>
    <hr>
    <b>RCA Summary:</b><br>
    5 Whys:<br>${(c.whys||[]).map((w,i)=> (i+1)+'. '+w).join('<br>') || '-'}<br>
    Fishbone: ${(c.fishbone||[]).join(', ') || '-'}<br>
    Root Cause: ${c.rootCause||'-'}<br>
    Contributing Causes: ${c.contribCauses||'-'}<br>
    Verification of Cause: ${c.verifyCause||'-'}<br>
    <hr>
    <b>CAPAs:</b><br>
    ${(c.capas||[]).map(a=> '- '+a.title+' (Owner: '+(a.owner||'-')+', Due: '+(a.due||'-')+', Status: '+(a.status||'Open')+')').join('<br>') || 'None'}<br>
    <hr>
    <b>Effectiveness:</b> ${c.effectiveness||'-'} — ${c.effectivenessNotes||''}<br>
    <hr>
    <b>Sign-offs:</b> QA Lead / Department Manager (demo)
  `;
});

// ====== Permit page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('permitForm');
  if(form){
    // Submit new permit
    form.addEventListener('submit', e=>{
      e.preventDefault();
      let permits = getStore('permits');
      const id = uid();
      const rec = {
        id,
        no: nextPermitNo(id),
        // extended permit fields
        type: document.getElementById('permitType').value,
        title: document.getElementById('permitTitle').value,
        location: document.getElementById('permitLocation').value,
        start: document.getElementById('permitStart').value,
        end: document.getElementById('permitEnd').value,
        hazards: document.getElementById('permitHazards').value,
        controls: document.getElementById('permitControls').value,
        envAspects: document.getElementById('permitEnvAspects').value,
        waste: document.getElementById('permitWaste').value,
        emergency: document.getElementById('permitEmergency').value,
        issuer: document.getElementById('permitIssuer').value,
        issuerDept: document.getElementById('permitIssuerDept').value,
        requestedBy: document.getElementById('permitRequester').value,
        dept: document.getElementById('permitDept').value,
        description: document.getElementById('permitDesc').value,
        status: 'Requested',
        actions: [],
        history: ['Permit created']
      };
      permits.push(rec); setStore('permits', permits); location.reload();
    });
    // Populate table
    const table = document.getElementById('permitTable');
    const list = getStore('permits');
    list.forEach(p=>{
      const r = table.insertRow();
      r.insertCell(0).innerText = p.no;
      r.insertCell(1).innerText = p.title || '';
      r.insertCell(2).innerText = p.location || '';
      r.insertCell(3).innerText = p.dept || '';
      r.insertCell(4).innerText = fmtD(p.start);
      // status with badge
      const sCell = r.insertCell(5);
      sCell.innerHTML = badgeStatus(p.status);
      // Manage button
      const mCell = r.insertCell(6);
      const mBtn = document.createElement('button'); mBtn.textContent = 'Manage';
      mBtn.onclick = ()=>{ window.location = 'permit_detail.html?id='+p.id; };
      mCell.appendChild(mBtn);
      // Delete button
      const dCell = r.insertCell(7);
      const dBtn = document.createElement('button'); dBtn.textContent='Delete'; dBtn.style.background='#c73636';
      dBtn.onclick = ()=> deletePermit(p.id);
      dCell.appendChild(dBtn);
    });
    // Setup search/filter and export for permit list
    setupListPage('searchPermits','exportPermits','permitTable','permits');
  }
});

// ====== Safety issues page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('safetyForm');
  if(form){
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      let safety = getStore('safety');
      const id = uid();
      // Build base record
      const rec = {
        id,
        no: nextSafetyNo(id),
        title: document.getElementById('safetyTitle').value,
        type: document.getElementById('safetyType').value,
        location: document.getElementById('safetyLocation').value,
        date: document.getElementById('safetyDate').value,
        reportedBy: document.getElementById('safetyReportedBy').value,
        severity: document.getElementById('safetySeverity').value,
        hazardType: document.getElementById('safetyHazardType') ? document.getElementById('safetyHazardType').value : '',
        // New incident classification fields (optional)
        incidentCategory: document.getElementById('safetyIncidentCategory') ? document.getElementById('safetyIncidentCategory').value : '',
        peopleAffected: (function(){ const el = document.getElementById('safetyPeopleAffected'); const n = el ? parseInt(el.value) : 0; return isNaN(n) ? 0 : n; })(),
        envImpact: document.getElementById('safetyEnvImpact') ? document.getElementById('safetyEnvImpact').value : '',
        cost: (function(){ const el = document.getElementById('safetyCost'); const f = el ? parseFloat(el.value) : 0; return isNaN(f) ? 0 : f; })(),
        description: document.getElementById('safetyDesc').value,
        status: 'New',
        actions: [],
        history: ['Safety issue reported']
      };
      // Process photo attachments
      const fileInput = document.getElementById('safetyImages');
      if(fileInput && fileInput.files && fileInput.files.length>0){
        rec.images = [];
        const promises = [];
        Array.from(fileInput.files).forEach(file=>{
          const reader = new FileReader();
          promises.push(new Promise(resolve=>{
            reader.onload = evt=>{
              rec.images.push({ name: file.name, data: evt.target.result });
              resolve();
            };
          }));
          reader.readAsDataURL(file);
        });
        await Promise.all(promises);
      }
      safety.push(rec); setStore('safety', safety); location.reload();
    });
    const table = document.getElementById('safetyTable');
    const list = getStore('safety');
    // Populate hazard category select from settings
    const hazardSel = document.getElementById('safetyHazardType');
    if(hazardSel){
      let types = JSON.parse(localStorage.getItem('hazardTypes') || '[]');
      if(!types || types.length === 0){ types = DEFAULT_CATEGORIES.hazardTypes; localStorage.setItem('hazardTypes', JSON.stringify(types)); }
      hazardSel.innerHTML = '';
      types.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        hazardSel.appendChild(opt);
      });
    }
    list.forEach(s=>{
      const r = table.insertRow();
      r.insertCell(0).innerText = s.no;
      r.insertCell(1).innerText = s.title || '';
      r.insertCell(2).innerText = s.type || '';
      r.insertCell(3).innerText = s.severity || '';
      r.insertCell(4).innerText = fmtD(s.date);
      const sCell = r.insertCell(5);
      sCell.innerHTML = badgeStatus(s.status);
      const mCell = r.insertCell(6);
      const mBtn = document.createElement('button'); mBtn.textContent='Manage';
      mBtn.onclick=()=>{ window.location='safety_detail.html?id='+s.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(7);
      const dBtn = document.createElement('button'); dBtn.textContent='Delete'; dBtn.style.background='#c73636';
      dBtn.onclick=()=> deleteSafety(s.id);
      dCell.appendChild(dBtn);
    });
    // Setup search/filter and export for safety list
    setupListPage('searchSafety','exportSafety','safetyTable','safety');
  }
});

// ====== SDS page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('sdsForm');
  if(form){
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      let sds = getStore('sds');
      const id = uid();
      const rec = {
        id,
        no: nextSdsNo(id),
        name: document.getElementById('sdsName').value,
        number: document.getElementById('sdsNumber').value,
        location: document.getElementById('sdsLocation').value,
        revision: document.getElementById('sdsRevision').value,
        expiry: document.getElementById('sdsExpiry').value,
        notes: document.getElementById('sdsNotes').value,
        status: 'Valid',
        actions: [],
        history: ['SDS created']
      };
      // Process SDS PDF upload
      const fileInput = document.getElementById('sdsFile');
      if(fileInput && fileInput.files && fileInput.files.length>0){
        const file = fileInput.files[0];
        const reader = new FileReader();
        await new Promise(resolve=>{
          reader.onload = evt=>{
            rec.file = { name: file.name, data: evt.target.result };
            resolve();
          };
        });
        reader.readAsDataURL(file);
      }
      sds.push(rec); setStore('sds', sds); location.reload();
    });
    const table = document.getElementById('sdsTable');
    const list = getStore('sds');
    list.forEach(d=>{
      const r = table.insertRow();
      r.insertCell(0).innerText = d.no;
      r.insertCell(1).innerText = d.name || '';
      r.insertCell(2).innerText = d.number || '';
      r.insertCell(3).innerText = fmtD(d.revision);
      r.insertCell(4).innerText = fmtD(d.expiry);
      const sCell = r.insertCell(5);
      sCell.innerHTML = badgeStatus(d.status);
      const mCell = r.insertCell(6);
      const mBtn=document.createElement('button'); mBtn.textContent='Manage';
      mBtn.onclick=()=>{ window.location='sds_detail.html?id='+d.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(7);
      const delBtn=document.createElement('button'); delBtn.textContent='Delete'; delBtn.style.background='#c73636';
      delBtn.onclick=()=> deleteSds(d.id);
      dCell.appendChild(delBtn);
    });
    // Setup search/filter and export for SDS list
    setupListPage('searchSds','exportSds','sdsTable','sds');
  }
});

// ====== Training page ======
document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('trainingForm');
  if(form){
    form.addEventListener('submit', e => {
      e.preventDefault();
      let training = getStore('training');
      const id = uid();
      // get selected participants as an array of employee ids
      const participantSel = document.getElementById('trainingParticipants');
      let selected = [];
      if(participantSel){
        selected = Array.from(participantSel.selectedOptions).map(opt => opt.value);
      }
      const rec = {
        id,
        no: nextTrainingNo(id),
        title: document.getElementById('trainingTitle').value,
        date: document.getElementById('trainingDate').value,
        instructor: document.getElementById('trainingInstructor').value,
        dept: document.getElementById('trainingDept').value,
        participants: selected,
        category: document.getElementById('trainingCategory') ? document.getElementById('trainingCategory').value : '',
        status: document.getElementById('trainingStatus').value || 'Scheduled',
        notes: document.getElementById('trainingNotes').value,
        actions: [],
        history: ['Training scheduled']
      };
      training.push(rec);
      setStore('training', training);
      // Record audit log
      addAuditLog('Schedule Training', 'Training ' + rec.title + ' scheduled');
      location.reload();
    });
    // Populate participants multi-select with current employees
    const partSel = document.getElementById('trainingParticipants');
    if(partSel){
      const employees = getStore('employees');
      // clear existing options first
      partSel.innerHTML = '';
      employees.forEach(emp => {
        const opt = document.createElement('option');
        opt.value = emp.id;
        opt.textContent = `${emp.name} (${emp.empId})`;
        partSel.appendChild(opt);
      });
    }
    const table = document.getElementById('trainingTable');
    const list = getStore('training');
    const employees = getStore('employees');
    // Populate training categories select
    const catSel = document.getElementById('trainingCategory');
    if(catSel){
      let cats = JSON.parse(localStorage.getItem('trainingCategories') || '[]');
      if(!cats || cats.length === 0){ cats = DEFAULT_CATEGORIES.trainingCategories; localStorage.setItem('trainingCategories', JSON.stringify(cats)); }
      catSel.innerHTML = '';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        catSel.appendChild(opt);
      });
    }
    list.forEach(t => {
      const r = table.insertRow();
      r.insertCell(0).innerText = t.no;
      r.insertCell(1).innerText = t.title || '';
      r.insertCell(2).innerText = fmtD(t.date);
      r.insertCell(3).innerText = t.instructor || '';
      // Category cell
      r.insertCell(4).innerText = t.category || '';
      // Participants names are resolved from employees list. If no participants are recorded, show '-'.
      let partNames = '-';
      let participants = [];
      if(Array.isArray(t.participants)) participants = t.participants;
      else if(t.participants) participants = [t.participants];
      if(participants.length){
        const names = [];
        participants.forEach(pid => {
          const e = employees.find(em => String(em.id) === String(pid));
          if(e) names.push(e.name);
        });
        if(names.length) partNames = names.join(', ');
      }
      r.insertCell(5).innerText = partNames;
      const sCell = r.insertCell(6);
      sCell.innerHTML = badgeStatus(t.status);
      const mCell = r.insertCell(7);
      const mBtn = document.createElement('button'); mBtn.textContent = 'Manage'; mBtn.onclick = () => { window.location = 'training_detail.html?id=' + t.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(8);
      const dBtn = document.createElement('button'); dBtn.textContent = 'Delete'; dBtn.style.background = '#c73636';
      dBtn.onclick = () => deleteTraining(t.id);
      dCell.appendChild(dBtn);
    });
    // Setup search/filter and export for training list
    setupListPage('searchTraining','exportTraining','trainingTable','training');

    // Handle training import from CSV
    const importBtn = document.getElementById('importTrainingBtn');
    if(importBtn){
      importBtn.addEventListener('click', async () => {
        const fileInput = document.getElementById('trainingImportFile');
        if(!fileInput || !fileInput.files || fileInput.files.length === 0){
          alert('Please select a CSV file to import');
          return;
        }
        const file = fileInput.files[0];
        try{
          const text = await file.text();
          const lines = text.trim().split(/\r?\n/);
          if(lines.length <= 1){
            alert('CSV file appears to be empty');
            return;
          }
          // Assume the first line is a header row with comma-separated columns
          const header = lines[0].split(',');
          const idx = (name) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
          const idxTitle = idx('title') >= 0 ? idx('title') : 0;
          const idxDate = idx('date');
          const idxInstr = idx('instructor');
          const idxDept = idx('department');
          const idxParts = idx('participants');
          const idxCat = idx('category');
          const idxStat = idx('status');
          const idxNotes = idx('notes');
          const idxCert = (function(){
            const idx1 = idx('certificate');
            if(idx1 >= 0) return idx1;
            const idx2 = idx('cert');
            return idx2;
          })();
          let trainings = getStore('training') || [];
          const employeesList = getStore('employees') || [];
          for(let i=1; i<lines.length; i++){
            const cols = lines[i].split(',');
            if(cols.every(c => c.trim() === '')) continue;
            const title = cols[idxTitle] || cols[0];
            const date = (idxDate >= 0 ? cols[idxDate] : '') || '';
            const instructor = (idxInstr >= 0 ? cols[idxInstr] : '') || '';
            const dept = (idxDept >= 0 ? cols[idxDept] : '') || '';
            const partsRaw = (idxParts >= 0 ? cols[idxParts] : '') || '';
            const participantIds = [];
            if(partsRaw){
              const names = partsRaw.split(';').map(s => s.trim()).filter(Boolean);
              names.forEach(name => {
                const emp = employeesList.find(e => e.name === name || String(e.empId) === name);
                if(emp) participantIds.push(emp.id);
              });
            }
            const category = (idxCat >= 0 ? cols[idxCat] : '') || '';
            const status = (idxStat >= 0 ? cols[idxStat] : 'Scheduled') || 'Scheduled';
            const notes = (idxNotes >= 0 ? cols[idxNotes] : '') || '';
            const certificate = (idxCert >= 0 ? cols[idxCert] : '') || '';
            const newId = uid();
            const rec = {
              id: newId,
              no: nextTrainingNo(newId),
              title: title,
              date: date,
              instructor: instructor,
              dept: dept,
              participants: participantIds,
              category: category,
              status: status,
              notes: notes,
              certificate: certificate,
              actions: [],
              history: ['Training imported']
            };
            trainings.push(rec);
          }
          setStore('training', trainings);
          addAuditLog('Import Training','Imported training records from CSV');
          alert('Training records imported successfully');
          location.reload();
        } catch(err){
          console.error(err);
          alert('Failed to import CSV');
        }
      });
    }
  }
});

// ====== Permit detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('permit_detail.html')) return;
  const params = new URLSearchParams(window.location.search); const id = params.get('id');
  let permits = getStore('permits');
  const p = findById(permits, id);
  if(!p){ const el=document.getElementById('permitHeader'); if(el) el.innerHTML='<p>Permit not found.</p>'; return; }
  // Header with extended details
  document.getElementById('permitHeader').innerHTML = `<b>${p.no}</b> — <b>${p.title}</b><br>
    Type: ${p.type || '-'} | Location: ${p.location || '-'} | Issuer: ${p.issuer || '-'} | Performer: ${p.requestedBy || '-'} | Dept: ${p.dept || '-'} | Start: ${fmtD(p.start)} | End: ${fmtD(p.end)}`;
  // Overview cards for hazards, controls and notes
  const ov = document.getElementById('permitOverview');
  if(ov){
    // Present key permit details in multiple cards. A grid is used so that fields wrap neatly. Each
    // card covers a major section of the permit including hazards, controls, environmental aspects,
    // waste management, emergency response and additional notes.
    ov.innerHTML = `
      <div class="grid-3">
        <div class="card"><b>Hazards Identified</b><br>${p.hazards || '-'}</div>
        <div class="card"><b>Control Measures / PPE &amp; Isolation</b><br>${p.controls || '-'}</div>
        <div class="card"><b>Environmental Aspects / Impacts</b><br>${p.envAspects || '-'}</div>
        <div class="card"><b>Waste Management &amp; Disposal</b><br>${p.waste || '-'}</div>
        <div class="card"><b>Emergency / Spill Response</b><br>${p.emergency || '-'}</div>
        <div class="card"><b>Additional Notes</b><br>${p.description || '-'}</div>
      </div>`;
  }
  // Status select
  const statusSel = document.getElementById('permitStatus');
  if(statusSel){ statusSel.value = p.status || 'Requested'; }
  // Save status
  window.savePermitStatus = function(){
    const newStatus = document.getElementById('permitStatus').value;
    p.status = newStatus;
    p.history = p.history || [];
    p.history.push('Status updated to '+newStatus);
    setStore('permits', permits);
    // Record audit log and sync tasks
    addAuditLog('Update Permit Status', 'Permit ' + p.no + ' status changed to ' + newStatus);
    updateBackendTasks();
    alert('Status saved.'); location.reload();
  };
  // Actions list
  const actList = document.getElementById('permitActionList');
  if(actList){
    (p.actions||[]).forEach(a=>{
      const li=document.createElement('li');
      li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner||'-'}, Due: ${fmtD(a.due)} ) — Status: ${a.status||'Open'}`;
      actList.appendChild(li);
    });
  }
  // Add action
  const form = document.getElementById('permitActionForm');
  if(form){
    form.addEventListener('submit', e=>{
      e.preventDefault();
      // Determine owner name and attempt to resolve to an employee or user for email notification
      const ownerInput = document.getElementById('paOwner').value;
      let ownerName = ownerInput || '';
      let ownerId = '';
      let ownerEmail = '';
      // If owner value begins with usr- then treat as user id
      if (ownerInput && ownerInput.startsWith('usr-')) {
        const uidStr = ownerInput.slice(4);
        const users = getStore('users') || [];
        const user = users.find(u => String(u.id) === String(uidStr));
        if (user) {
          ownerName = user.username + (user.role ? ' (' + user.role + ')' : '');
          ownerEmail = user.email || '';
          ownerId = 'usr-' + user.id;
        }
      } else if (ownerInput) {
        // Search employees by name or employee ID
        const employees = getStore('employees') || [];
        const emp = employees.find(e => e.name === ownerInput || String(e.empId) === String(ownerInput));
        if (emp) {
          ownerName = emp.name || ownerInput;
          ownerEmail = emp.email || '';
          ownerId = String(emp.id);
        }
      }
      const a = {
        id: uid(),
        title: document.getElementById('paTitle').value,
        owner: ownerName,
        ownerId: ownerId ? 'usr-' + ownerId : '',
        ownerEmail,
        dept: document.getElementById('paDept').value,
        due: document.getElementById('paDue').value,
        status:'Open',
        source:'Permit',
        sourceRef:p.no
      };
      p.actions = (p.actions||[]);
      p.actions.push(a);
      p.history = p.history || [];
      p.history.push('Action added: '+a.title);
      // push to global actions
      let actions = getStore('actions');
      actions.push({...a});
      setStore('actions', actions);
      setStore('permits', permits);
      // Send notification to owner if email is available
      if (a.ownerEmail) {
        const subj = `Action Assigned: ${a.title}`;
        const body = `You have been assigned a permit action: ${a.title}. Permit: ${p.no}. Due: ${a.due || 'TBD'}.`;
        sendEmail(a.ownerEmail, subj, body);
      }
      // Record audit log and sync tasks
      addAuditLog('Add Permit Action', 'Action ' + a.title + ' added to permit ' + p.no);
      updateBackendTasks();
      location.reload();
    });
  }
  // History
  const histUl = document.getElementById('permitHistory');
  if(histUl){
    (p.history||[]).forEach(h=>{ const li=document.createElement('li'); li.textContent=h; histUl.appendChild(li); });
  }
  // Open first tab
  const firstTab = document.querySelector('.tablink'); if(firstTab) firstTab.click();
});

// ====== Safety detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('safety_detail.html')) return;
  const params = new URLSearchParams(window.location.search); const id = params.get('id');
  let safety = getStore('safety');
  const rec = findById(safety, id);
  if(!rec){ const el=document.getElementById('safetyHeader'); if(el) el.innerHTML='<p>Safety issue not found.</p>'; return; }
  document.getElementById('safetyHeader').innerHTML = `<b>${rec.no}</b> — <b>${rec.title}</b><br>Type: ${rec.type} | Hazard: ${rec.hazardType || '-'} | Severity: ${rec.severity} | Location: ${rec.location || '-'} | Date: ${fmtD(rec.date)} | Reported By: ${rec.reportedBy || '-'}`;
  const ov = document.getElementById('safetyOverview');
  if(ov){
    // Present description and incident classification details in separate cards
    const descCard = `<div class="card"><b>Description</b><br>${rec.description || '-'}</div>`;
    const classCard = `<div class="card"><b>Incident Details</b><br>
      Category: ${rec.incidentCategory || '-'}<br>
      People Affected: ${rec.peopleAffected !== undefined ? rec.peopleAffected : '-'}<br>
      Environmental Impact: ${rec.envImpact || '-'}<br>
      Cost: ${rec.cost && rec.cost > 0 ? ('$' + rec.cost) : '-'}</div>`;
    ov.innerHTML = `<div class="grid-2">${descCard}${classCard}</div>`;
  }
  // Render uploaded images
  const imgDiv = document.getElementById('safetyImagesView');
  if(imgDiv){
    imgDiv.innerHTML = '';
    if(rec.images && rec.images.length){
      rec.images.forEach(img=>{
        const el = document.createElement('img');
        el.src = img.data;
        el.alt = img.name;
        // Provide a larger thumbnail and enable click to view full size. Using max-width ensures
        // multiple images still wrap nicely in the grid.
        el.style.maxWidth = '200px';
        el.style.margin = '4px';
        el.style.cursor = 'pointer';
        el.onclick = ()=>{ window.open(img.data, '_blank'); };
        imgDiv.appendChild(el);
      });
    }
  }
  const statusSel = document.getElementById('safetyStatus'); if(statusSel) statusSel.value = rec.status || 'New';
  window.saveSafetyStatus = function(){
    const newStatus = document.getElementById('safetyStatus').value;
    rec.status = newStatus;
    rec.history = rec.history || [];
    rec.history.push('Status updated to '+newStatus);
    setStore('safety', safety);
    // Record audit log and sync tasks
    addAuditLog('Update Safety Status', 'Safety issue ' + rec.no + ' status changed to ' + newStatus);
    updateBackendTasks();
    alert('Status saved.'); location.reload();
  };

  // Prepopulate investigation fields if present
  const whysInput = document.getElementById('safetyWhys');
  const rcInput = document.getElementById('safetyRootCause');
  const contribInput = document.getElementById('safetyContribCauses');
  const verifyInput = document.getElementById('safetyVerifyCause');
  if(whysInput){
    whysInput.value = (rec.whys || []).join('\n');
  }
  if(rcInput){ rcInput.value = rec.rootCause || ''; }
  if(contribInput){ contribInput.value = rec.contribCauses || ''; }
  if(verifyInput){ verifyInput.value = rec.verifyCause || ''; }
  // Save investigation function
  window.saveSafetyInvestigation = function(){
    const lines = (document.getElementById('safetyWhys').value || '').split('\n').map(s => s.trim()).filter(Boolean);
    rec.whys = lines.slice(0, 5);
    rec.rootCause = document.getElementById('safetyRootCause').value;
    rec.contribCauses = document.getElementById('safetyContribCauses').value;
    rec.verifyCause = document.getElementById('safetyVerifyCause').value;
    rec.status = 'Investigating';
    rec.history = rec.history || [];
    rec.history.push('Investigation saved');
    setStore('safety', safety);
    addAuditLog('Safety Investigation', 'Investigation updated for safety issue ' + rec.no);
    updateBackendTasks();
    alert('Investigation saved.');
    location.reload();
  };
  // Actions list
  const listEl = document.getElementById('safetyActionList');
  if(listEl){
    (rec.actions||[]).forEach(a=>{
      const li=document.createElement('li');
      li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner||'-'}, Due: ${fmtD(a.due)}) — Status: ${a.status||'Open'}`;
      listEl.appendChild(li);
    });
  }
  const form = document.getElementById('safetyActionForm');
  if(form){
    form.addEventListener('submit', e=>{
      e.preventDefault();
      const a = { id: uid(), title: document.getElementById('siTitle').value, owner: document.getElementById('siOwner').value, dept: document.getElementById('siDept').value, due: document.getElementById('siDue').value, status:'Open', source:'Safety', sourceRef:rec.no };
      rec.actions = (rec.actions||[]); rec.actions.push(a);
      rec.history = rec.history || []; rec.history.push('Action added: '+a.title);
      let actions = getStore('actions'); actions.push({...a}); setStore('actions', actions);
      setStore('safety', safety);
      // Record audit log and sync tasks
      addAuditLog('Add Safety Action', 'Action ' + a.title + ' added to safety issue ' + rec.no);
      updateBackendTasks();
      location.reload();
    });
  }
  const hist = document.getElementById('safetyHistory');
  if(hist){ (rec.history||[]).forEach(h=>{ let li=document.createElement('li'); li.textContent=h; hist.appendChild(li); }); }
  const firstTab = document.querySelector('.tablink'); if(firstTab) firstTab.click();
});

// ====== SDS detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('sds_detail.html')) return;
  const params = new URLSearchParams(window.location.search); const id = params.get('id');
  let sds = getStore('sds');
  const rec = findById(sds, id);
  if(!rec){ const el=document.getElementById('sdsHeader'); if(el) el.innerHTML='<p>SDS not found.</p>'; return; }
  document.getElementById('sdsHeader').innerHTML = `<b>${rec.no}</b> — <b>${rec.name}</b><br>SDS #: ${rec.number || '-'} | Location: ${rec.location || '-'} | Revision: ${fmtD(rec.revision)} | Expiry: ${fmtD(rec.expiry)}`;
  const ov = document.getElementById('sdsOverview');
  if(ov){ ov.innerHTML = `<div class="card"><b>Notes</b><br>${rec.notes || '-'}</div>`; }
  // Display link to uploaded SDS file
  const fileLinkDiv = document.getElementById('sdsFileLink');
  if(fileLinkDiv){
    if(rec.file && rec.file.data){
      const name = rec.file.name || 'SDS.pdf';
      fileLinkDiv.innerHTML = `<a href="${rec.file.data}" target="_blank" download="${name}">View / Download SDS (${name})</a>`;
    } else {
      fileLinkDiv.innerHTML = '<em>No SDS file uploaded</em>';
    }
  }
  const statusSel = document.getElementById('sdsStatus'); if(statusSel) statusSel.value = rec.status || 'Valid';
  window.saveSdsStatus = function(){
    const newStatus = document.getElementById('sdsStatus').value;
    rec.status = newStatus;
    rec.history = rec.history || [];
    rec.history.push('Status updated to '+newStatus);
    setStore('sds', sds);
    alert('Status saved.'); location.reload();
  };
  const listEl = document.getElementById('sdsActionList');
  if(listEl){
    (rec.actions||[]).forEach(a=>{
      const li=document.createElement('li'); li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner||'-'}, Due: ${fmtD(a.due)}) — Status: ${a.status||'Open'}`;
      listEl.appendChild(li);
    });
  }
  const form = document.getElementById('sdsActionForm');
  if(form){
    form.addEventListener('submit', e=>{
      e.preventDefault();
      const a = { id: uid(), title: document.getElementById('sdsActTitle').value, owner: document.getElementById('sdsActOwner').value, dept: document.getElementById('sdsActDept').value, due: document.getElementById('sdsActDue').value, status:'Open', source:'SDS', sourceRef:rec.no };
      rec.actions = (rec.actions||[]); rec.actions.push(a);
      rec.history = rec.history || []; rec.history.push('Action added: '+a.title);
      let actions = getStore('actions'); actions.push({...a}); setStore('actions', actions);
      setStore('sds', sds); location.reload();
    });
  }
  const hist = document.getElementById('sdsHistory');
  if(hist){ (rec.history||[]).forEach(h=>{ let li=document.createElement('li'); li.textContent=h; hist.appendChild(li); }); }
  const firstTab = document.querySelector('.tablink'); if(firstTab) firstTab.click();
});

// ====== Training detail page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('training_detail.html')) return;
  const params = new URLSearchParams(window.location.search); const id = params.get('id');
  let training = getStore('training');
  const rec = findById(training, id);
  if(!rec){ const el=document.getElementById('trainingHeader'); if(el) el.innerHTML='<p>Training record not found.</p>'; return; }
  // Resolve participant names for header display
  let participantNames = '-';
  let parts = [];
  if(Array.isArray(rec.participants)) parts = rec.participants;
  else if(rec.participants) parts = [rec.participants];
  if(parts.length){
    const employees = getStore('employees');
    const names = [];
    parts.forEach(pid => {
      const emp = employees.find(e => String(e.id) === String(pid));
      if(emp) names.push(emp.name);
    });
    if(names.length) participantNames = names.join(', ');
  }
  document.getElementById('trainingHeader').innerHTML = `<b>${rec.no}</b> — <b>${rec.title}</b><br>Date: ${fmtD(rec.date)} | Instructor: ${rec.instructor || '-'} | Dept: ${rec.dept || '-'} | Category: ${rec.category || '-'} | Participants: ${participantNames}${rec.certificate ? ' | Certificate: ' + rec.certificate : ''}`;
  const ov = document.getElementById('trainingOverview');
  if(ov){ ov.innerHTML = `<div class="card"><b>Gaps/Notes</b><br>${rec.notes || '-'}</div>`; }
  const statusSel = document.getElementById('trainingStatusSelect'); if(statusSel) statusSel.value = rec.status || 'Scheduled';
  window.saveTrainingStatus = function(){
    const newStatus = document.getElementById('trainingStatusSelect').value;
    rec.status = newStatus;
    rec.history = rec.history || [];
    rec.history.push('Status updated to '+newStatus);
    setStore('training', training);
    alert('Status saved.'); location.reload();
  };
  const listEl = document.getElementById('trainingActionList');
  if(listEl){
    (rec.actions||[]).forEach(a=>{
      const li=document.createElement('li'); li.innerHTML = `<b>${a.title}</b> (Owner: ${a.owner||'-'}, Due: ${fmtD(a.due)}) — Status: ${a.status||'Open'}`;
      listEl.appendChild(li);
    });
  }
  const form = document.getElementById('trainingActionForm');
  if(form){
    form.addEventListener('submit', e=>{
      e.preventDefault();
      const a = { id: uid(), title: document.getElementById('trActTitle').value, owner: document.getElementById('trActOwner').value, dept: document.getElementById('trActDept').value, due: document.getElementById('trActDue').value, status:'Open', source:'Training', sourceRef:rec.no };
      rec.actions = (rec.actions||[]); rec.actions.push(a);
      rec.history = rec.history || []; rec.history.push('Action added: '+a.title);
      let actions = getStore('actions'); actions.push({...a}); setStore('actions', actions);
      setStore('training', training); location.reload();
    });
  }
  const hist = document.getElementById('trainingHistory');
  if(hist){ (rec.history||[]).forEach(h=>{ let li=document.createElement('li'); li.textContent=h; hist.appendChild(li); }); }
  const firstTab = document.querySelector('.tablink'); if(firstTab) firstTab.click();
});

// ====== Employees page ======
document.addEventListener('DOMContentLoaded', () => {
  const empForm = document.getElementById('employeeForm');
  if(empForm){
    // Populate role select if present
    const roleSelect = document.getElementById('empRole');
    if(roleSelect){
      populateRoleSelect(roleSelect);
    }
    // Add employee
    empForm.addEventListener('submit', e => {
      e.preventDefault();
      let employees = getStore('employees');
      const id = uid();
      const rec = {
        id,
        empId: document.getElementById('empId').value,
        name: document.getElementById('empName').value,
        email: document.getElementById('empEmail') ? document.getElementById('empEmail').value : '',
        dept: document.getElementById('empDept').value,
        position: document.getElementById('empPosition').value,
        role: document.getElementById('empRole') ? document.getElementById('empRole').value : ''
      };
      employees.push(rec);
      setStore('employees', employees);
      // Record audit log for employee creation
      addAuditLog('Add Employee', 'Employee ' + rec.name + ' (' + rec.empId + ') added');
      // Automatically create a user for this employee if an email is provided and no user exists.  The
      // email becomes the username.  If the email already exists as a user, link the existing user
      // to this employee by setting employeeId if it's not already set.
      if(rec.email && rec.email.trim() !== ''){
        const em = rec.email.trim().toLowerCase();
        let users = getStore('users');
        // See if user exists using this email as username or email
        let existingIdx = users.findIndex(u => (u.username||'').toLowerCase() === em || (u.email||'').toLowerCase() === em);
        if(existingIdx === -1){
          const newUser = {
            id: uid(),
            username: em,
            password: btoa('changeme123'),
            role: rec.role || 'user',
            email: em,
            active: true,
            lastLogin: '',
            employeeId: rec.id
          };
          users.push(newUser);
          setStore('users', users);
          addAuditLog('Auto User Create', 'User ' + em + ' created automatically for employee ' + rec.name);
        } else {
          // existing user: link to employee if not already linked
          if(!users[existingIdx].employeeId || users[existingIdx].employeeId === ''){
            users[existingIdx].employeeId = rec.id;
            setStore('users', users);
          }
        }
      }
      // Sync tasks to backend (new employees may be assigned to tasks in future)
      updateBackendTasks();
      location.reload();
    });
    // Render employees table
    const table = document.getElementById('employeeTable');
    const employees = getStore('employees');
    employees.forEach(emp => {
      const r = table.insertRow();
      r.insertCell(0).innerText = emp.empId || '';
      r.insertCell(1).innerText = emp.name || '';
      r.insertCell(2).innerText = emp.email || '';
      r.insertCell(3).innerText = emp.dept || '';
      r.insertCell(4).innerText = emp.position || '';
      // Role column
      r.insertCell(5).innerText = emp.role || '';
      const mCell = r.insertCell(6);
      const mBtn = document.createElement('button'); mBtn.textContent = 'Manage';
      mBtn.onclick = () => { window.location = 'employee_detail.html?id=' + emp.id; };
      mCell.appendChild(mBtn);
      const dCell = r.insertCell(7);
      const dBtn = document.createElement('button'); dBtn.textContent = 'Delete'; dBtn.style.background = '#c73636';
      dBtn.onclick = () => deleteEmployee(emp.id);
      dCell.appendChild(dBtn);
    });
    // Setup search/filter and export for employees list
    setupListPage('searchEmployees','exportEmployees','employeeTable','employees');
  }
});

// ====== Employee detail page ======
document.addEventListener('DOMContentLoaded', () => {
  if(!window.location.pathname.includes('employee_detail.html')) return;
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const employees = getStore('employees');
  const emp = findById(employees, id);
  if(!emp){ const header = document.getElementById('employeeHeader'); if(header) header.innerHTML = '<p>Employee not found.</p>'; return; }
  // Header information
  const header = document.getElementById('employeeHeader');
  if(header){
    header.innerHTML = `<b>${emp.empId}</b> — <b>${emp.name}</b><br>` +
      `Email: ${emp.email || '-'}<br>` +
      `Dept: ${emp.dept || '-'} | Position: ${emp.position || '-'} | Role: ${emp.role || '-'}`;
  }
  // Profile section
  const profile = document.getElementById('empProfile');
  if(profile){
    profile.innerHTML = `
      <div class="grid-3">
        <div class="card"><b>Employee ID</b><br>${emp.empId || '-'}</div>
        <div class="card"><b>Name</b><br>${emp.name || '-'}</div>
        <div class="card"><b>Email</b><br>${emp.email || '-'}</div>
        <div class="card"><b>Department</b><br>${emp.dept || '-'}</div>
        <div class="card"><b>Position</b><br>${emp.position || '-'}</div>
        <div class="card"><b>Role</b><br>${emp.role || '-'}</div>
      </div>`;
  }
  // Populate training matrix for this employee
  const trainingList = getStore('training');
  const table = document.getElementById('empTrainingTable');
  // Compute required training categories for the employee's role
  const reqDiv = document.getElementById('empReqTraining');
  if(reqDiv){
    let mapping = JSON.parse(localStorage.getItem('roleRequirements') || '{}');
    // Ensure mapping is initialised
    if(Object.keys(mapping).length === 0) mapping = Object.assign({}, DEFAULT_ROLE_REQUIREMENTS);
    // Required categories for this employee's role
    const reqCats = Array.isArray(mapping[emp.role]) ? mapping[emp.role] : [];
    if(reqCats && reqCats.length > 0){
      // For each required category, determine the highest applicable status (Completed > Scheduled > Overdue > Not Scheduled)
      let html = `<p><b>Required Training (${emp.role || 'Unassigned'})</b></p><ul>`;
      reqCats.forEach(cat => {
        let status = 'Not Scheduled';
        let schedDate = '';
        trainingList.forEach(t => {
          let participants = [];
          if(Array.isArray(t.participants)) participants = t.participants;
          else if(t.participants) participants = [t.participants];
          if(participants.map(String).includes(String(emp.id)) && t.category === cat){
            if(t.status === 'Completed'){ status = 'Completed'; }
            else if(t.status === 'Scheduled' && status !== 'Completed'){ status = 'Scheduled'; schedDate = t.date || ''; }
            else if(t.status === 'Overdue' && status !== 'Completed' && status !== 'Scheduled'){ status = 'Overdue'; }
          }
        });
        let badge;
        if(status === 'Completed'){
          badge = '<span class="badge training-complete">Completed</span>';
        } else if(status === 'Scheduled'){
          badge = '<span class="badge training-scheduled">Scheduled' + (schedDate ? ' (' + schedDate + ')' : '') + '</span>';
        } else if(status === 'Overdue'){
          badge = '<span class="badge training-pending">Overdue</span>';
        } else {
          badge = '<span class="badge training-pending">Not Scheduled</span>';
        }
        html += `<li>${cat}: ${badge}</li>`;
      });
      html += '</ul>';
      reqDiv.innerHTML = html;
    } else {
      reqDiv.innerHTML = '<p><i>No training requirements defined for this role.</i></p>';
    }
  }

  // Compute required training courses for employee's role
  const reqCourseDiv = document.getElementById('empReqCourses');
  if(reqCourseDiv){
    let courseMap = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
    if(Object.keys(courseMap).length === 0) courseMap = Object.assign({}, DEFAULT_ROLE_COURSE_REQS);
    const requiredCourses = Array.isArray(courseMap[emp.role]) ? courseMap[emp.role] : [];
    if(requiredCourses && requiredCourses.length > 0){
      let html = `<p><b>Required Courses (${emp.role || 'Unassigned'})</b></p><ul>`;
      requiredCourses.forEach(course => {
        let status = 'Not Scheduled';
        let schedDate = '';
        trainingList.forEach(t => {
          let participants = [];
          if(Array.isArray(t.participants)) participants = t.participants;
          else if(t.participants) participants = [t.participants];
          if(participants.map(String).includes(String(emp.id)) && t.title === course){
            if(t.status === 'Completed'){ status = 'Completed'; }
            else if(t.status === 'Scheduled' && status !== 'Completed'){ status = 'Scheduled'; schedDate = t.date || ''; }
            else if(t.status === 'Overdue' && status !== 'Completed' && status !== 'Scheduled'){ status = 'Overdue'; }
          }
        });
        let badge;
        if(status === 'Completed'){
          badge = '<span class="badge training-complete">Completed</span>';
        } else if(status === 'Scheduled'){
          badge = '<span class="badge training-scheduled">Scheduled' + (schedDate ? ' (' + schedDate + ')' : '') + '</span>';
        } else if(status === 'Overdue'){
          badge = '<span class="badge training-pending">Overdue</span>';
        } else {
          badge = '<span class="badge training-pending">Not Scheduled</span>';
        }
        html += `<li>${course}: ${badge}</li>`;
      });
      html += '</ul>';
      reqCourseDiv.innerHTML = html;
    } else {
      reqCourseDiv.innerHTML = '<p><i>No course requirements defined for this role.</i></p>';
    }
  }

  // Compute and display training summary/gaps for this employee
  const overviewDiv = document.getElementById('empTrainingOverview');
  if(overviewDiv){
    // Determine the list of courses required for this employee's role
    let courseMap2 = JSON.parse(localStorage.getItem('roleCourseRequirements') || '{}');
    if(Object.keys(courseMap2).length === 0) courseMap2 = Object.assign({}, DEFAULT_ROLE_COURSE_REQS);
    const required = Array.isArray(courseMap2[emp.role]) ? courseMap2[emp.role] : [];
    // Collect training sessions for this employee
    const sessions = (getStore('training') || []).filter(t => {
      let participants = [];
      if(Array.isArray(t.participants)) participants = t.participants;
      else if(t.participants) participants = [t.participants];
      return participants.map(String).includes(String(emp.id));
    });
    const completed = [];
    const scheduled = [];
    const overdue = [];
    const missing = [];
    required.forEach(course => {
      // Find session matching this course
      const sess = sessions.find(s => s.title === course);
      if(sess){
        if(sess.status === 'Completed') completed.push(course);
        else if(sess.status === 'Scheduled') scheduled.push({ course: course, date: sess.date || '' });
        else if(sess.status === 'Overdue') overdue.push(course);
        else missing.push(course);
      } else {
        // no training session scheduled; mark as missing
        missing.push(course);
      }
    });
    let html = '';
    if(required.length === 0){
      html = '<p><i>No training requirements defined for this role.</i></p>';
    } else {
      html += '<h4>Training Summary</h4>';
      if(completed.length > 0){
        html += '<p><b>Completed:</b> ' + completed.join(', ') + '</p>';
      }
      if(scheduled.length > 0){
        html += '<p><b>Scheduled:</b> ' + scheduled.map(item => item.course + (item.date ? ' (' + fmtD(item.date) + ')' : '')).join(', ') + '</p>';
      }
      if(overdue.length > 0){
        html += '<p><b>Overdue:</b> ' + overdue.join(', ') + '</p>';
      }
      if(missing.length > 0){
        html += '<p><b>Not Scheduled:</b> ' + missing.join(', ') + '</p>';
      }
    }
    overviewDiv.innerHTML = html;
  }
  if(table){
    trainingList.forEach(t => {
      // Convert participants to array
      let participants = [];
      if(Array.isArray(t.participants)) participants = t.participants;
      else if(t.participants) participants = [t.participants];
      // Check if this employee is in the training participants list
      if(participants.map(String).includes(String(emp.id))){
        const row = table.insertRow();
        row.insertCell(0).innerText = t.no;
        row.insertCell(1).innerText = t.title || '';
        row.insertCell(2).innerText = fmtD(t.date);
        // Category cell
        row.insertCell(3).innerText = t.category || '';
        const statusCell = row.insertCell(4);
        statusCell.innerHTML = badgeStatus(t.status);
        const mCell = row.insertCell(5);
        const mBtn = document.createElement('button'); mBtn.textContent = 'Manage';
        mBtn.onclick = () => { window.location = 'training_detail.html?id=' + t.id; };
        mCell.appendChild(mBtn);
      }
    });
  }
  // Assign training form
  const assignForm = document.getElementById('empAssignForm');
  if(assignForm){
    // Pre-fill department default from employee
    const deptInput = document.getElementById('empTrDept');
    if(deptInput) deptInput.value = emp.dept || '';
    // Populate training category select from settings
    const catSel = document.getElementById('empTrCategory');
    if(catSel){
      let cats = JSON.parse(localStorage.getItem('trainingCategories') || '[]');
      if(!cats || cats.length === 0){ cats = DEFAULT_CATEGORIES.trainingCategories; localStorage.setItem('trainingCategories', JSON.stringify(cats)); }
      catSel.innerHTML = '';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        catSel.appendChild(opt);
      });
    }
    assignForm.addEventListener('submit', e => {
      e.preventDefault();
      let training = getStore('training');
      const newId = uid();
      const rec = {
        id: newId,
        no: nextTrainingNo(newId),
        title: document.getElementById('empTrTitle').value,
        date: document.getElementById('empTrDate').value,
        instructor: document.getElementById('empTrInstructor').value,
        dept: document.getElementById('empTrDept').value || emp.dept,
        participants: [emp.id],
        category: document.getElementById('empTrCategory') ? document.getElementById('empTrCategory').value : '',
        status: document.getElementById('empTrStatus').value || 'Scheduled',
        notes: document.getElementById('empTrNotes').value,
        actions: [],
        history: [
          `Training scheduled for employee ${emp.name}`
        ]
      };
      training.push(rec);
      setStore('training', training);
      alert('Training scheduled for employee');
      location.reload();
    });
  }
  // Open first tab automatically
  const firstTab = document.querySelector('.tablink');
  if(firstTab) firstTab.click();
});

// ====== Actions page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.getElementById('actionForm')) return;
  // Hide the create action form for users without edit privileges.  This
  // ensures that regular users can only work on tasks assigned to them
  // rather than creating new actions.
  if(!canEdit()){
    const formEl = document.getElementById('actionForm');
    if(formEl){
      formEl.style.display = 'none';
    }
  }
  // Add action
  // Populate owner/assignee select with employees and users
  if(document.getElementById('actionOwner')){
    populateAssigneeSelect('actionOwner', true);
  }
  actionForm.addEventListener('submit', e=>{
    e.preventDefault();
    let actions = getStore('actions');
    // Determine owner details
    const selected = document.getElementById('actionOwner') ? document.getElementById('actionOwner').value : '';
    let ownerName = '';
    let ownerEmail = '';
    let ownerId = selected;
    if(selected){
      if(selected.startsWith('emp-')){
        const idPart = selected.slice(4);
        const employees = getStore('employees') || [];
        const emp = employees.find(e => String(e.id) === String(idPart));
        if(emp){ ownerName = emp.name || ''; ownerEmail = emp.email || ''; }
      } else if(selected.startsWith('usr-')){
        const idPart = selected.slice(4);
        const users = getStore('users') || [];
        const user = users.find(u => String(u.id) === String(idPart));
        if(user){ ownerName = user.username + (user.role ? ' (' + user.role + ')' : ''); ownerEmail = user.email || ''; }
      }
    }
    const due = actionDue.value;
    const remInput = document.getElementById('actionReminder');
    let reminderDays = 0;
    if(remInput && remInput.value){ const parsed = parseInt(remInput.value); if(!isNaN(parsed)) reminderDays = parsed; }
    // fallback to default from settings
    if(reminderDays === 0){
      const notif = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
      if(notif.reminderDays) reminderDays = notif.reminderDays;
    }
    actions.push({ id: uid(), title: actionTitle.value, source: actionSource.value, ownerId, owner: ownerName, ownerEmail, dept: actionDept.value, due, reminderDays, status: 'Open', qaEvidence: '' });
    setStore('actions', actions);
    // Send notification
    if(ownerEmail){
      const subj = `Action Assigned: ${actionTitle.value}`;
      const body = `You have been assigned an action: ${actionTitle.value}. Source: ${actionSource.value}. Due: ${due || 'TBD'}.`;
      sendEmail(ownerEmail, subj, body);
    }
    // Record audit log
    addAuditLog('Create Action', 'Action ' + actionTitle.value + ' created');
    // Sync tasks to backend
    updateBackendTasks();
    renderActions();
    actionForm.reset();
  });
  function overdueBadge(a){
    if(a.due && a.status!=='Verified Closed' && a.due < today()){ const days=Math.ceil((new Date(today())-new Date(a.due))/86400000); return `<span class="badge overdue">Overdue ${days}d</span>`; }
    return '';
  }
  function renderActions(){
    // Only display actions the current user is authorised to see.  Users
    // without edit privileges only see actions assigned directly to them.
    let actions = getStore('actions') || [];
    const current = getCurrentUser();
    if (!canEdit()) {
      actions = actions.filter(a => {
        if(!a.ownerId || !current) return false;
        // Build list of allowed numeric IDs
        const allowedIds = [String(current.id)];
        if(current.employeeId) allowedIds.push(String(current.employeeId));
        // Extract id part by removing 'usr-' or 'emp-' prefixes
        const idPart = String(a.ownerId).replace(/^usr-|^emp-/, '');
        return allowedIds.includes(String(idPart));
      });
    }
    const cols = { "Open": kanbanOpen, "In Progress": kanbanProgress, "Pending Verification": kanbanPending, "Verified Closed": kanbanClosed };
    Object.values(cols).forEach(ul=> ul.innerHTML='');
    actions.forEach(a=>{
      const li=document.createElement('li');
      li.innerHTML = `<b>${a.title}</b> (${a.source}) — ${a.owner||'-'} ${overdueBadge(a)}<br>
        Due: ${a.due||'-'} | Dept: ${a.dept||'-'}<br>
        Status: ${a.status}<br>`;
      // Bulk select checkbox at the beginning of each list item
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'bulk-select';
      cb.checked = selectedActions.has(String(a.id));
      cb.addEventListener('change', (e) => {
        if(e.target.checked) selectedActions.add(String(a.id));
        else selectedActions.delete(String(a.id));
        renderBulkControls();
      });
      li.prepend(cb);
      // Make the list item draggable for drag‑and‑drop status changes
      li.setAttribute('draggable','true');
      li.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', a.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      const wrap = document.createElement('div');
      // Determine if the current user can edit this particular record.  A user
      // can edit if they have global edit permissions (canEdit()) or if
      // they are the owner of the action.  For non‑editable users, only
      // limited controls will be displayed.
      let editable = canEdit();
      if(!editable && a.ownerId && current){
        // A user can edit an action if they are the assigned owner.  Owner IDs are
        // stored with either a 'usr-' or 'emp-' prefix.  Build a list of allowed
        // IDs using the current user's id for user assignments and the current
        // employeeId for employee assignments.  Note that employee assignments
        // use an 'emp-' prefix, not 'usr-'.  The previous implementation
        // incorrectly prefixed employee IDs with 'usr-', which prevented
        // employees from seeing their own actions.
        const owners = ['usr-' + current.id];
        if(current.employeeId) owners.push('emp-' + current.employeeId);
        editable = owners.includes(a.ownerId);
      }
      // Status-based controls
      // Owners (or users with edit permission) can progress or complete their own
      // actions when they are still open or in progress.  Completion will mark
      // the action as pending verification.  Verification to close an action
      // should only be performed by users with QA privileges (canVerify()).
      if(editable && (a.status === "Open" || a.status === "In Progress")){
        const prog = document.createElement('button');
        prog.textContent = 'Start/Progress';
        prog.onclick = () => update(a.id,{ status:'In Progress' });
        const done = document.createElement('button');
        done.textContent = 'Mark Completed (Owner)';
        done.onclick = () => update(a.id,{ status:'Pending Verification' });
        wrap.appendChild(prog);
        wrap.appendChild(done);
      }
      // QA verification controls – displayed only to users with QA privileges
      if(a.status === "Pending Verification" && canVerify()){
        const inp = document.createElement('input');
        inp.placeholder = 'QA evidence note';
        inp.style.marginRight = '6px';
        const ver = document.createElement('button');
        ver.textContent = 'Verify & Close (QA)';
        ver.onclick = () => update(a.id,{ status:'Verified Closed', qaEvidence: inp.value || 'Verified' });
        wrap.appendChild(inp);
        wrap.appendChild(ver);
      }
      // Delete control only for authorised users or the owner themselves
      if(editable){
        const del=document.createElement('button');
        del.textContent='Delete';
        del.style.background='#c73636';
        del.onclick=()=> deleteAction(a.id);
        wrap.appendChild(del);
      }
      li.appendChild(wrap);
      cols[a.status]?.appendChild(li);
    });
    // Setup drag‑and‑drop handlers on columns to allow moving actions between statuses.
    Object.keys(cols).forEach(status => {
      const ul = cols[status];
      ul.ondragover = e => { e.preventDefault(); };
      ul.ondrop = e => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        if(id){
          update(id, { status });
        }
      };
    });
    // Update bulk controls display based on current selection
    if(typeof renderBulkControls === 'function'){
      renderBulkControls();
    }
    // Reflect CAPA status back to complaint CAPAs
    let complaints = getStore('complaints'); let changed=false;
    complaints.forEach(c=>{
      (c.capas||[]).forEach(cap=>{
        const a = getStore('actions').find(x=>x.title===cap.title && x.source==='Complaint' && x.sourceRef===c.ccNo);
        if(a && cap.status!==a.status){ cap.status = a.status; changed=true; }
      });
    });
    if(changed) setStore('complaints', complaints);
  }
  /**
   * Update an action record by ID with the given patch.  This helper
   * normalises status updates, writes to localStorage, records audit logs,
   * syncs tasks to the backend and re-renders the actions list.  It is
   * attached to the global window object so it can be used from the
   * dashboard and other pages.  Without exposing this function globally
   * the inline task buttons on the dashboard would not operate as they
   * reside outside of the Action Management page scope.
   *
   * @param {String|Number} id The unique ID of the action to update.
   * @param {Object} patch The fields to update on the action.
   */
  // The update helper is now defined at the top level so other modules
  // (including the home page) can reuse it.  Simply invoke renderActions
  // to redraw the action board after the initial page load.
  renderActions();

  // Handle bulk import of actions from CSV.  Admins or users with edit
  // rights can import multiple actions at once.  The CSV should have
  // headers like title, source, owner, department, due, reminder, status.
  const importBtn = document.getElementById('importActionsBtn');
  if(importBtn){
    importBtn.addEventListener('click', async ()=>{
      const fileInput = document.getElementById('actionImportFile');
      if(!fileInput || !fileInput.files || fileInput.files.length === 0){
        alert('Please select a CSV file to import');
        return;
      }
      const file = fileInput.files[0];
      try{
        const text = await file.text();
        const lines = text.trim().split(/\r?\n/);
        if(lines.length <= 1){
          alert('CSV file appears to be empty');
          return;
        }
        const header = lines[0].split(',');
        const idx = name => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
        const idxTitle = idx('title') >= 0 ? idx('title') : 0;
        const idxSource = idx('source');
        const idxOwner = (()=>{ const a = idx('owner'); return a >=0 ? a : idx('assigned'); })();
        const idxDept = idx('department');
        const idxDue = (()=>{ const a = idx('due'); if(a >=0) return a; const b = idx('duedate'); return b; })();
        const idxRem = (()=>{ const a = idx('reminder'); if(a >=0) return a; const b = idx('rem'); return b; })();
        const idxStatus = idx('status');
        let actions = getStore('actions') || [];
        const employees = getStore('employees') || [];
        const users = getStore('users') || [];
        let imported = 0;
        for(let i=1; i<lines.length; i++){
          const cols = lines[i].split(',');
          if(cols.every(c => c.trim() === '')) continue;
          const title = cols[idxTitle] || cols[0] || '';
          const source = (idxSource >= 0 ? cols[idxSource] : '') || 'Other';
          const ownerVal = (idxOwner >= 0 ? cols[idxOwner] : '') || '';
          const dept = (idxDept >= 0 ? cols[idxDept] : '') || '';
          const due = (idxDue >= 0 ? cols[idxDue] : '') || '';
          const rem = (idxRem >= 0 ? cols[idxRem] : '') || '';
          const status = (idxStatus >= 0 ? cols[idxStatus] : '') || 'Open';
          // Determine owner details
          let ownerId = '';
          let ownerName = '';
          let ownerEmail = '';
          if(ownerVal){
            // match employee by name or id
            const emp = employees.find(e => {
              return (e.name && e.name.trim().toLowerCase() === ownerVal.trim().toLowerCase()) ||
                     (String(e.empId) === String(ownerVal)) ||
                     (String(e.id) === String(ownerVal));
            });
            if(emp){
              ownerId = 'emp-' + emp.id;
              ownerName = emp.name || '';
              ownerEmail = emp.email || '';
            } else {
              const user = users.find(u => {
                return (u.username && u.username.trim().toLowerCase() === ownerVal.trim().toLowerCase()) ||
                       (u.email && u.email.trim().toLowerCase() === ownerVal.trim().toLowerCase()) ||
                       (String(u.id) === String(ownerVal));
              });
              if(user){
                ownerId = 'usr-' + user.id;
                ownerName = user.username + (user.role ? ' (' + user.role + ')' : '');
                ownerEmail = user.email || '';
              }
            }
          }
          let reminderDays = 0;
          if(rem){
            const parsed = parseInt(rem);
            if(!isNaN(parsed)) reminderDays = parsed;
          }
          // Fallback to default reminder
          if(reminderDays === 0){
            const notif = JSON.parse(localStorage.getItem('notificationSettings') || '{}');
            if(notif.reminderDays) reminderDays = notif.reminderDays;
          }
          actions.push({ id: uid(), title, source, ownerId, owner: ownerName, ownerEmail, dept, due, reminderDays, status: status || 'Open', qaEvidence: '' });
          // Send notification if email exists
          if(ownerEmail){
            const subj = `Action Assigned: ${title}`;
            const body = `You have been assigned an action: ${title}. Source: ${source}. Due: ${due || 'TBD'}.`;
            sendEmail(ownerEmail, subj, body);
          }
          // Audit log
          addAuditLog('Create Action', 'Action ' + title + ' created via import');
          imported++;
        }
        setStore('actions', actions);
        updateBackendTasks();
        alert(imported + ' actions imported');
        location.reload();
      } catch(err){
        console.error(err);
        alert('Failed to import actions: ' + err.message);
      }
    });
  }


});

// ====== Audits page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.getElementById('auditForm')) return;
  auditForm.addEventListener('submit', e=>{
    e.preventDefault();
    let audits = getStore('audits');
    const freq = document.getElementById('auditFreq') ? document.getElementById('auditFreq').value : '';
    audits.push({ id:uid(), year:auditYear.value, std:auditStd.value, bu:auditBU.value, area:auditArea.value, auditor:auditAuditor.value, date:auditDate.value, freq: freq || '', status:'Planned', history:['Audit created'], findings:[], checklist:[] });
    setStore('audits', audits); renderAudits();
    auditForm.reset();
  });
  function renderAudits(){
    const tb = auditTable;
    tb.innerHTML = "<tr><th>Year</th><th>Std(s)</th><th>BU</th><th>Area</th><th>Lead Auditor</th><th>Date</th><th>Status</th><th>Manage</th><th>Delete</th></tr>";
    getStore('audits').forEach(a=>{
      const r=tb.insertRow();
      r.insertCell(0).innerText=a.year;
      r.insertCell(1).innerText=a.std;
      r.insertCell(2).innerText=a.bu;
      r.insertCell(3).innerText=a.area;
      r.insertCell(4).innerText=a.auditor;
      r.insertCell(5).innerText=a.date;
      r.insertCell(6).innerText=a.status;
      // manage button
      const manageCell=r.insertCell(7);
      const manageBtn=document.createElement('button');
      manageBtn.textContent='Manage';
      manageBtn.onclick=()=>{ window.location='audit_detail.html?id='+a.id; };
      manageCell.appendChild(manageBtn);
      // delete button
      const delCell = r.insertCell(8);
      const delBtn=document.createElement('button');
      delBtn.textContent='Delete';
      delBtn.style.background='#c73636';
      delBtn.onclick=()=> deleteAudit(a.id);
      delCell.appendChild(delBtn);
    });
  }
  renderAudits();
  // Setup search/filter and export for audits list
  setupListPage('searchAudits','exportAudits','auditTable','audits');
});

// ====== Audit Detail ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('audit_detail.html')) return;
  const id = new URLSearchParams(window.location.search).get('id');
  let audits = getStore('audits'); let a = findById(audits, id);
  if(!a){ document.body.innerHTML='<div class="container"><p>Audit not found.</p></div>'; return; }

  auditHeader.innerHTML = `<b>AUD-${a.id}</b> — ${a.area} (${a.bu}) | ${a.std} | Lead: ${a.auditor} | Date: ${fmtD(a.date)} | Status: ${a.status}`;
  auditOverview.innerHTML = `<div class="card"><b>Overview</b><br>Year: ${a.year} | BU: ${a.bu} | Area: ${a.area}<br>Standards: ${a.std}<br>Lead: ${a.auditor} | Date: ${fmtD(a.date)}</div>`;
  const hist = document.getElementById('auditHistory'); (a.history||[]).forEach(h=>{ let li=document.createElement('li'); li.textContent=h; hist.appendChild(li); });

  // Findings
  function renderFindings(){
    findingTable.innerHTML = '<tr><th>ID</th><th>Type</th><th>Clause</th><th>Statement</th><th>Responsible</th><th>Target</th><th>Status</th><th>Actions</th></tr>';
    (a.findings||[]).forEach(f=>{
      const r=findingTable.insertRow();
      r.insertCell(0).innerText='F-'+f.id; r.insertCell(1).innerText=f.type; r.insertCell(2).innerText=f.clause; r.insertCell(3).innerText=f.statement;
      r.insertCell(4).innerText=f.resp; r.insertCell(5).innerText=f.due; r.insertCell(6).innerText=f.status;
      const act=r.insertCell(7);
      const btnA=document.createElement('button');
      btnA.textContent='Create Action';
      btnA.onclick=()=>{
        let actions = getStore('actions');
        const title = `Audit ${a.area} - ${f.type} (${f.clause})`;
        // Determine owner details from finding responsible field
        let ownerName = f.resp || '';
        let ownerId = '';
        let ownerEmail = '';
        if (f.resp && f.resp.startsWith('usr-')) {
          const uidStr = f.resp.slice(4);
          const users = getStore('users') || [];
          const user = users.find(u => String(u.id) === String(uidStr));
          if (user) {
            ownerName = user.username + (user.role ? ' (' + user.role + ')' : '');
            ownerEmail = user.email || '';
            ownerId = 'usr-' + user.id;
          }
        } else if (f.resp) {
          const employees = getStore('employees') || [];
          const emp = employees.find(e => e.name === f.resp || String(e.empId) === String(f.resp));
          if (emp) {
            ownerName = emp.name || f.resp;
            ownerEmail = emp.email || '';
            ownerId = String(emp.id);
          }
        }
        const newA = {
          id: uid(),
          title,
          source:'Audit',
          owner: ownerName,
          ownerId: ownerId ? 'usr-' + ownerId : '',
          ownerEmail,
          dept:'',
          due:f.due,
          status:'Open',
          qaEvidence:'',
          sourceRef:`AUD-${a.id}:F-${f.id}`
        };
        actions.push(newA);
        setStore('actions', actions);
        // Send notification if email exists
        if (newA.ownerEmail) {
          const subj = `Action Assigned: ${newA.title}`;
          const body = `You have been assigned an audit action: ${newA.title}. Due: ${newA.due || 'TBD'}.`;
          sendEmail(newA.ownerEmail, subj, body);
        }
        // Sync tasks to backend
        updateBackendTasks();
        alert('Action created and sent to Action Board.');
      };
      const btnB=document.createElement('button'); btnB.textContent='Mark Awaiting Verification'; btnB.onclick=()=>{ f.status='Awaiting Verification'; a.history.push(`Finding F-${f.id} awaiting verification`); setStore('audits', audits); renderFindings(); };
      const btnC=document.createElement('button'); btnC.textContent='Verify & Close'; btnC.onclick=()=>{ f.status='Closed (Verified)'; a.history.push(`Finding F-${f.id} verified closed`); setStore('audits', audits); renderFindings(); };
      act.appendChild(btnA); act.appendChild(btnB); act.appendChild(btnC);
    });
  }
  findingForm.addEventListener('submit', e=>{
    e.preventDefault();
    const f = { id: uid(), type:fType.value, clause:fClause.value, statement:fStatement.value, resp:fResp.value, due:fDue.value, status:'Open' };
    a.findings = (a.findings||[]); a.findings.push(f); a.history.push(`Finding F-${f.id} created`); setStore('audits', audits); renderFindings(); findingForm.reset();
  });
  renderFindings();

  // Checklist handling
  // Ensure checklist property exists
  if(!Array.isArray(a.checklist)) a.checklist = [];

  function renderChecklist(){
    const tbl = document.getElementById('checklistTable');
    const summaryEl = document.getElementById('checklistSummary');
    if(!tbl) return;
    tbl.innerHTML = '<tr><th>#</th><th>Item</th><th>Score</th><th>Evidence</th><th>Delete</th></tr>';
    let total = 0;
    a.checklist.forEach((item, idx) => {
      total += parseFloat(item.score) || 0;
      const r = tbl.insertRow();
      r.insertCell(0).innerText = idx + 1;
      r.insertCell(1).innerText = item.question;
      r.insertCell(2).innerText = item.score;
      r.insertCell(3).innerText = item.evidence || '';
      const delCell = r.insertCell(4);
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.style.background = '#c73636';
      delBtn.onclick = () => {
        // Remove item by index
        a.checklist.splice(idx, 1);
        a.history.push('Checklist item removed');
        setStore('audits', audits);
        renderChecklist();
      };
      delCell.appendChild(delBtn);
    });
    // Show summary (average score)
    if(summaryEl){
      const count = a.checklist.length;
      if(count > 0){
        const avg = (total / count).toFixed(2);
        summaryEl.textContent = `Total items: ${count}, Average score: ${avg}`;
      } else {
        summaryEl.textContent = '';
      }
    }
  }

  const clForm = document.getElementById('checklistForm');
  if(clForm){
    clForm.addEventListener('submit', e => {
      e.preventDefault();
      const q = document.getElementById('clQuestion').value.trim();
      const sc = document.getElementById('clScore').value;
      const ev = document.getElementById('clEvidence').value.trim();
      if(!q) return;
      a.checklist.push({ question: q, score: sc || '0', evidence: ev });
      a.history.push('Checklist item added');
      setStore('audits', audits);
      document.getElementById('clQuestion').value = '';
      document.getElementById('clScore').value = 0;
      document.getElementById('clEvidence').value = '';
      renderChecklist();
    });
  }
  // Render checklist on load
  renderChecklist();

  // Open default tab
  const tabs=document.querySelectorAll('.tablink'); if(tabs[0]) tabs[0].click();
});

// ====== MOM page ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.getElementById('momForm')) return;
  momForm.addEventListener('submit', e=>{
    e.preventDefault();
    let mom = getStore('mom');
    const id = uid(); const no = momNo.value || ('MOM-' + id);
    mom.push({ id, no, dt:momDT.value, org:momOrg.value, att:momAtt.value, agenda:momAgenda.value, dec:momDec.value, next:momNext.value, actions:[] });
    setStore('mom', mom); renderMoms(); momForm.reset();
  });
  function renderMoms(){
    momTable.innerHTML = '<tr><th>Mtg #</th><th>Date</th><th>Organizer</th><th>Attendees</th><th>Manage</th><th>Delete</th></tr>';
    getStore('mom').forEach(m=>{
      const r=momTable.insertRow();
      r.insertCell(0).innerText=m.no;
      r.insertCell(1).innerText=fmtDT(m.dt);
      r.insertCell(2).innerText=m.org;
      r.insertCell(3).innerText=m.att;
      // Manage button
      const manageCell=r.insertCell(4);
      const manageBtn=document.createElement('button');
      manageBtn.textContent='Manage';
      manageBtn.onclick=()=>{ window.location='mom_detail.html?id='+m.id; };
      manageCell.appendChild(manageBtn);
      // Delete button
      const delCell=r.insertCell(5);
      const delBtn=document.createElement('button');
      delBtn.textContent='Delete';
      delBtn.style.background='#c73636';
      delBtn.onclick=()=> deleteMom(m.id);
      delCell.appendChild(delBtn);
    });
  }
  renderMoms();
  // Setup search/filter and export for MOM list
  setupListPage('searchMom','exportMom','momTable','mom');
});

// ====== MOM Detail ======
document.addEventListener('DOMContentLoaded', ()=>{
  if(!window.location.pathname.includes('mom_detail.html')) return;
  const id = new URLSearchParams(window.location.search).get('id');
  let data = getStore('mom'); let m=findById(data,id);
  if(!m){ document.body.innerHTML='<div class="container"><p>MOM not found.</p></div>'; return; }
  momHeader.innerHTML = `<b>${m.no}</b> | ${fmtDT(m.dt)} | Organizer: ${m.org}<br>Attendees: ${m.att}<br>Agenda: ${m.agenda}<br>Decisions: ${m.dec}<br>Next Review: ${fmtD(m.next)}`;

  function render(){
    momActionList.innerHTML='';
    (m.actions||[]).forEach(a=>{
      let li=document.createElement('li');
      // Build textual description
      const span=document.createElement('span');
      span.textContent = `${a.title} (Owner: ${a.owner||'-'}, Due: ${a.due||'-'}) — ${a.status}`;
      li.appendChild(span);
      // Delete button for each inline action
      const delBtn=document.createElement('button');
      delBtn.textContent='Delete';
      delBtn.style.background='#c73636';
      delBtn.style.marginLeft='8px';
      delBtn.onclick=()=> deleteMomAction(m.id, a.id);
      li.appendChild(delBtn);
      momActionList.appendChild(li);
    });
  }
  momActionForm.addEventListener('submit', e=>{
    e.preventDefault();
    const a = { id:uid(), title:mActTitle.value, owner:mActOwner.value, dept:mActDept.value, due:mActDue.value, status:'Open', source:'MOM', sourceRef:m.no };
    m.actions = (m.actions||[]); m.actions.push(a); setStore('mom', data);
    let actions = getStore('actions'); actions.push({...a}); setStore('actions', actions);
    render(); momActionForm.reset();
  });
  render();
});

// ===== Risk module pages =====
// Handle risk list and risk detail pages.  This listener initialises the risk register when
// the relevant DOM elements are present.  It runs after other page handlers to avoid
// conflicts and to ensure dependent helpers like badgeStatus and setupListPage exist.
document.addEventListener('DOMContentLoaded', () => {
  // Risk register list page
  const riskForm = document.getElementById('riskForm');
  if (riskForm) {
    // Populate category select
    const catSel = document.getElementById('riskCategory');
    if (catSel) {
      let cats;
      try {
        cats = JSON.parse(localStorage.getItem('riskCategories') || '[]');
      } catch (e) {
        cats = [];
      }
      if (!cats || cats.length === 0) {
        cats = DEFAULT_CATEGORIES.riskCategories;
        localStorage.setItem('riskCategories', JSON.stringify(cats));
      }
      catSel.innerHTML = '';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        catSel.appendChild(opt);
      });
    }
    // Populate status select for new risk
    const statusSel = document.getElementById('riskStatus');
    if (statusSel) {
      let statuses;
      try {
        statuses = JSON.parse(localStorage.getItem('riskStatuses') || '[]');
      } catch (e) {
        statuses = [];
      }
      if (!statuses || statuses.length === 0) {
        statuses = DEFAULT_STATUSES.riskStatuses;
        localStorage.setItem('riskStatuses', JSON.stringify(statuses));
      }
      statusSel.innerHTML = '';
      statuses.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        statusSel.appendChild(opt);
      });
    }
    // Render existing risks into the table
    const table = document.getElementById('riskTable');
    if (table) {
      // Clear existing rows except header
      while (table.rows.length > 1) {
        table.deleteRow(1);
      }
      const risks = getStore('risks') || [];
      risks.forEach(r => {
        const row = table.insertRow();
        row.insertCell(0).innerText = r.no || '';
        row.insertCell(1).innerText = r.title || '';
        row.insertCell(2).innerText = r.category || '';
        // Compute score on the fly if missing
        const score = typeof r.score !== 'undefined' ? r.score : ((r.likelihood || 1) * (r.impact || 1));
        row.insertCell(3).innerText = score;
        const rating = r.rating || (score >= 15 ? 'High' : (score >= 6 ? 'Medium' : 'Low'));
        row.insertCell(4).innerText = rating;
        const statusCell = row.insertCell(5);
        statusCell.innerHTML = badgeStatus(r.status || '');
        row.insertCell(6).innerText = r.owner || '';
        row.insertCell(7).innerText = fmtD(r.due);
        // Manage button
        const manageCell = row.insertCell(8);
        const mBtn = document.createElement('button');
        mBtn.textContent = 'Manage';
        mBtn.onclick = () => { window.location = 'risk_detail.html?id=' + r.id; };
        manageCell.appendChild(mBtn);
        // Delete button
        const delCell = row.insertCell(9);
        const dBtn = document.createElement('button');
        dBtn.textContent = 'Delete';
        dBtn.style.background = '#c73636';
        dBtn.onclick = () => {
          if (confirm('Delete risk ' + (r.no || r.title) + '?')) {
            deleteRisk(r.id);
            location.reload();
          }
        };
        delCell.appendChild(dBtn);
      });
      // Setup search and export for risks
      setupListPage('searchRisk', 'exportRisk', 'riskTable', 'risks');
    }
    // Handle creation of new risk
    riskForm.addEventListener('submit', e => {
      e.preventDefault();
      let risks = getStore('risks') || [];
      const id = uid();
      // Convert numeric fields
      const lik = parseInt(document.getElementById('riskLikelihood').value, 10) || 1;
      const imp = parseInt(document.getElementById('riskImpact').value, 10) || 1;
      const score = lik * imp;
      // Determine rating based on configurable thresholds
      const thresholds = getRiskThresholds();
      let rating = 'Low';
      if (score > thresholds.high) rating = 'High';
      else if (score > thresholds.low && score <= thresholds.medium) rating = 'Medium';
      else if (score > thresholds.medium) rating = 'High';
      const rec = {
        id: id,
        no: 'R' + (risks.length + 1),
        title: document.getElementById('riskTitle').value,
        category: document.getElementById('riskCategory').value || '',
        likelihood: lik,
        impact: imp,
        score: score,
        rating: rating,
        owner: document.getElementById('riskOwner').value || '',
        dept: document.getElementById('riskDept').value || '',
        due: document.getElementById('riskDue').value || '',
        mitigation: document.getElementById('riskMitigation').value || '',
        status: document.getElementById('riskStatus').value || (DEFAULT_STATUSES.riskStatuses ? DEFAULT_STATUSES.riskStatuses[0] : 'Identified'),
        history: ['Risk identified on ' + new Date().toLocaleString()]
      };
      risks.push(rec);
      setStore('risks', risks);
      addAuditLog('Add Risk', 'Risk ' + rec.title + ' added');
      // Reload to update list
      location.reload();
    });
  }
  // Risk detail page
  if (window.location.pathname.includes('risk_detail.html')) {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const risks = getStore('risks') || [];
    const risk = risks.find(r => String(r.id) === String(id));
    if (risk) {
      // Header summarising risk
      const hdr = document.getElementById('riskHeader');
      if (hdr) {
        hdr.innerHTML = `<h3>${risk.title}</h3><p>Score: ${risk.score} (${risk.rating}) – Category: ${risk.category}</p>`;
      }
      // Overview details
      const ov = document.getElementById('riskOverview');
      if (ov) {
        ov.innerHTML = '';
        const fields = [
          ['Title', risk.title || ''],
          ['Category', risk.category || ''],
          ['Likelihood', risk.likelihood || ''],
          ['Impact', risk.impact || ''],
          ['Score', risk.score || ''],
          ['Rating', risk.rating || ''],
          ['Owner', risk.owner || '-'],
          ['Department', risk.dept || '-'],
          ['Due Date', fmtD(risk.due)],
          ['Status', risk.status || ''],
          ['Mitigation Plan', risk.mitigation || '-']
        ];
        fields.forEach(([label, val]) => {
          const p = document.createElement('p');
          p.innerHTML = `<b>${label}:</b> ${val}`;
          ov.appendChild(p);
        });
      }
      // Populate status selector
      const sel = document.getElementById('riskStatusSelect');
      if (sel) {
        let statuses;
        try {
          statuses = JSON.parse(localStorage.getItem('riskStatuses') || '[]');
        } catch (e) {
          statuses = [];
        }
        if (!statuses || statuses.length === 0) {
          statuses = DEFAULT_STATUSES.riskStatuses;
          localStorage.setItem('riskStatuses', JSON.stringify(statuses));
        }
        sel.innerHTML = '';
        statuses.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s;
          if (s === risk.status) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      // Populate history list
      const hist = document.getElementById('riskHistory');
      if (hist) {
        hist.innerHTML = '';
        (risk.history || []).forEach(h => {
          const li = document.createElement('li');
          li.textContent = h;
          hist.appendChild(li);
        });
      }
      // Default to first tab if available
      const firstBtn = document.querySelector('.tablink');
      if (firstBtn) firstBtn.click();
    }
  }
});
