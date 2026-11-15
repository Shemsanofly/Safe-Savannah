// Login form: inline validation and duplicate-submit protection.
const form = document.querySelector('[data-login]');
if (form) {
  form.addEventListener('submit', (e) => {
    const id = form.querySelector('#operatorId');
    const pin = form.querySelector('#pin');
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
        form.querySelector('h2').nextElementSibling.after(msg);
      }
      msg.textContent = firstEmpty === id ? 'Enter your operator ID.' : 'Enter your PIN.';
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
