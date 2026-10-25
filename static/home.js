/* Home page extras: the example strip loops seamlessly, and the closing link box starts a tutorial the same way as the
   one at the top (it hands the link to the main box, which app.js owns). */
(function () {
  'use strict';
  const track = document.getElementById('marquee');
  if (track) track.innerHTML += track.innerHTML.replace(/<span class="ex"/g, '<span class="ex" aria-hidden="true"');
  const form = document.getElementById('ctaForm');
  if (form) form.addEventListener('submit', e => {
    e.preventDefault();
    const v = document.getElementById('url2').value.trim();
    if (!v) { document.getElementById('url2').focus(); return; }
    document.getElementById('url').value = v;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.getElementById('prepBtn').click();
  });
})();
