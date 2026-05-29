// Hermini landing — light interactions only.

// Year
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// Scroll reveal
const revealEls = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && revealEls.length) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('in'));
}

// Waitlist (front-end only — no data leaves the page)
const form = document.getElementById('waitlist-form');
const note = document.getElementById('waitlist-note');
if (form && note) {
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = form.querySelector('input[name="email"]');
    const value = (input && input.value ? input.value : '').trim();
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (!ok) {
      note.textContent = 'Hmm — that email looks off. Try again?';
      note.classList.remove('is-success');
      input?.focus();
      return;
    }
    note.textContent = "You're on the list. Hermini will wave when it ships. ✦";
    note.classList.add('is-success');
    form.reset();
  });
}

// Support link — intentionally points at an accountable channel, not a wallet.
// Until a real GitHub Sponsors / Open Collective URL is set, nudge politely.
document.querySelectorAll('[data-support]').forEach((el) => {
  el.addEventListener('click', (ev) => {
    if (el.getAttribute('href') === '#') {
      ev.preventDefault();
      window.alert(
        'Backing opens soon via GitHub Sponsors / Open Collective.\nSwap this link for your sponsors URL when ready.',
      );
    }
  });
});
