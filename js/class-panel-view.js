// This renderer receives a browser-safe projection. It may carry an internal
// class ID only inside a leave-button closure; it never renders that ID or any
// UID, learner reference, raw code, or server error.
function button(document, label, onClick, disabled = false) {
  const value = document.createElement('button'); value.type = 'button'; value.className = 'quiet-button'; value.textContent = label; value.disabled = disabled;
  if (!disabled) value.addEventListener('click', onClick); return value;
}

export function renderStudentClassPanel(els, state, dispatch, document = globalThis.document) {
  if (state.clearJoinCode) els.classJoinCode.value = '';
  const canRetry = ['ready', 'stale', 'error', 'pending-reconciliation'].includes(state.mode);
  const canJoin = state.mode === 'ready' && !state.pending && !state.busy;
  const leaveAllowed = canJoin;
  els.classStatus.textContent = state.message;
  els.classJoinForm.hidden = !canJoin;
  els.classJoinButton.disabled = !canJoin;
  els.classJoinCode.disabled = !canJoin;
  els.classRetry.hidden = !canRetry;
  els.classRetry.disabled = !canRetry;
  els.classRetry.onclick = () => dispatch({ type: 'retry' });
  els.classJoinForm.onsubmit = event => { event.preventDefault(); if (canJoin) dispatch({ type: 'join', joinCode: els.classJoinCode.value }); };
  els.classMemberships.replaceChildren();
  for (const item of state.memberships) {
    const row = document.createElement('article'); row.className = `class-membership${item.membershipStatus === 'left' ? ' prior' : ''}`;
    const copy = document.createElement('div'); copy.className = 'class-membership-copy';
    const title = document.createElement('h3'); title.textContent = item.className;
    const status = document.createElement('p'); status.textContent = item.membershipStatus === 'active' ? 'Active class' : 'Prior class';
    copy.append(title, status); row.append(copy);
    if (item.membershipStatus === 'active') row.append(button(document, 'Leave class', () => dispatch({ type: 'leave', classId: item.classId }), !leaveAllowed));
    els.classMemberships.append(row);
  }
}
