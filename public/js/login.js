// Login form: show/hide PIN, inline validation and duplicate-submit protection.
const form = document.querySelector('[data-login]');
if (form) {
  const pin = form.querySelector('#pin');
  const toggle = form.querySelector('.pin-toggle');
  toggle?.addEventListener('click', () => {
    const show = pin.type === 'password';
    pin.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
    pin.focus();
  });
  // Typing again clears the "not right" state.
  for (const input of form.querySelectorAll('input')) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));

  form.addEventListener('submit', (e) => {
    const id = form.querySelector('#operatorId');
    for (const input of [id, pin]) input.setAttribute('aria-invalid', input.value.trim() ? 'false' : 'true');
    const firstEmpty = [id, pin].find((i) => !i.value.trim());
    if (firstEmpty) {
      e.preventDefault();
      firstEmpty.focus();
      let msg = form.querySelector('#login-error');
      if (!msg) {
        msg = document.createElement('div');
        msg.id = 'login-error';
        msg.className = 'alert alert-error';
        msg.setAttribute('role', 'alert');
        form.querySelector('.login-card-head').after(msg);
      }
      msg.textContent = firstEmpty === id ? 'Enter your staff ID.' : 'Enter your PIN.';
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    if (btn.dataset.busy) {
      e.preventDefault();
      return;
    }
    btn.dataset.busy = '1';
    btn.setAttribute('aria-busy', 'true');
    btn.querySelector('span').textContent = 'Signing in…';
  });
}
