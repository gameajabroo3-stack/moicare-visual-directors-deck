(() => {
  'use strict';

  const storyboard = window.MOICARE_STORYBOARD;
  const sourceAssets = window.MOICARE_ASSETS || {};
  const $ = id => document.getElementById(id);
  const body = document.body;
  const requiredIds = ['scene-screen','scene-title','main-image','ambient-image','image-stage','image-empty','alternatives','previous-button','next-button','chapter-navigation','shot-navigation','index-dialog','index-list'];
  if (!storyboard || !Array.isArray(storyboard.scenes) || requiredIds.some(id => !$(id))) {
    console.error('The storyboard data or deck markup is incomplete.');
    if ($('image-empty')) {
      $('image-empty').hidden = false;
      $('image-empty').textContent = 'Data storyboard belum tersedia. Pastikan seluruh isi paket berada dalam folder yang sama.';
    }
    return;
  }

  const scenes = storyboard.scenes;
  const shots = scenes.flatMap(scene => scene.shots.map(shot => ({...shot, scene})));
  const pages = [{kind:'cover',id:'cover'}, ...shots.map(shot => ({kind:'shot',id:shot.id,shot})), {kind:'closing',id:'closing'}];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const selectedVariants = new Map();
  const imageCache = new Set();
  let currentIndex = 0;
  let mode = 'presentation';
  let panelOpen = true;
  let motionEnabled = !reducedMotion.matches;
  let currentVariants = [];
  let activeVariant = null;
  let imageRequest = 0;
  let ambientAnimation = null;
  let transitionAnimations = [];
  let toastTimer;
  let touchStart = null;
  let wheelTimer;
  let wheelAccumulator = 0;
  let wheelTriggered = false;
  let wheelLastAt = 0;

  const text = (id, value) => { if ($(id)) $(id).textContent = value == null ? '' : String(value); };
  const hidden = (id, value) => { if ($(id)) $(id).hidden = value; };
  const padded = value => String(value).padStart(2,'0');
  const currentPage = () => pages[currentIndex];
  const localImage = value => typeof value === 'string' && /^(?:\.\/)?assets\//.test(value) && !value.includes('..');
  const sanitizeText = value => typeof value === 'string' ? value : '';

  function notify(message) {
    text('toast', message);
    $('toast')?.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast')?.classList.remove('visible'), 3300);
  }

  function assetEntry(page) {
    if (page.kind === 'shot') return sourceAssets.shots?.[page.id] || {};
    return sourceAssets[page.kind] || {};
  }

  function variantsFor(page) {
    const entry = assetEntry(page);
    const list = Array.isArray(entry) ? entry : Array.isArray(entry.variants) ? entry.variants : entry.src ? [entry] : [];
    return list.filter(item => item && localImage(item.src)).map((item, index) => ({
      ...item,
      id: item.id || `${page.id}-visual-${index + 1}`,
      label: item.label || (index === 0 ? 'Main' : `ALT ${padded(index)}`),
      role: item.role || (index === 0 ? 'main' : 'alternative'),
      alt: item.alt || `${page.kind === 'shot' ? `${page.id} — ${page.shot.title}` : page.kind === 'cover' ? 'Visual pembuka MOICARE' : 'Hero visual penutup MOICARE'} — ${item.label || (index === 0 ? 'Main' : `ALT ${padded(index)}`)}`,
      approvalStatus: item.approvalStatus || 'unverified'
    }));
  }

  function cancelTransitionAnimations() {
    transitionAnimations.forEach(animation => animation.cancel());
    transitionAnimations = [];
  }

  function animateAmbient(replay = false) {
    if (ambientAnimation) ambientAnimation.cancel();
    ambientAnimation = null;
    body.classList.toggle('motion-off', !motionEnabled);
    if ($('motion-button')) {
      $('motion-button').setAttribute('aria-pressed', String(motionEnabled));
      $('motion-button').setAttribute('aria-label', motionEnabled ? 'Hentikan motion pendukung' : 'Aktifkan motion pendukung');
    }
    text('motion-label', motionEnabled ? 'Motion' : 'Statis');
    if ($('replay-button')) $('replay-button').disabled = !motionEnabled || mode === 'review' || !activeVariant;
    if (!motionEnabled || mode === 'review' || !activeVariant || $('ambient-image').hidden || typeof $('ambient-image').animate !== 'function') return;
    ambientAnimation = $('ambient-image').animate([
      {transform:'translate3d(-1.3%,.5%,0) scale(1.09)'},
      {transform:'translate3d(1.3%,-.5%,0) scale(1.13)'}
    ], {duration:5800,easing:'cubic-bezier(.2,.65,.3,1)',fill:'both'});
    if (replay) notify('Motion elemen pendukung diputar ulang.');
  }

  function setAssetStatus(variant, error = false) {
    const entry = assetEntry(currentPage());
    let status = 'Aset belum tersedia';
    if (variant) status = variant.approvalStatus === 'approved' ? 'Visual disetujui' : 'Kurasi untuk review';
    if (error) status = 'File gambar belum tersedia';
    text('asset-status', status);
    if ($('asset-status')) $('asset-status').dataset.status = error || !variant ? 'missing' : variant.approvalStatus === 'approved' ? 'approved' : 'review';
    body.dataset.assetStatus = error || !variant ? 'missing' : variant.approvalStatus === 'approved' ? 'approved' : 'review';
    const caption = variant?.sourceTitle || variant?.sourceFilename || variant?.originalFilename || '';
    text('source-caption', caption ? `Sumber: ${caption}` : 'Gambar hasil generate terpilih belum dipetakan.');
    const sourceDetail = [
      variant?.sourceFilename ? `File sumber: ${variant.sourceFilename}.` : '',
      variant?.sourceTitleOriginal || variant?.sourceTitle ? `Judul sumber: ${variant.sourceTitleOriginal || variant.sourceTitle}.` : '',
      variant?.note || '',
      entry.note || '',
      variant && variant.approvalStatus !== 'approved' ? 'Penempatan Main/ALT pada halaman ini adalah pilihan awal untuk review; belum menetapkan approval Director.' : ''
    ].filter(Boolean).join(' ');
    text('source-detail', sourceDetail || 'Aset tidak diganti dengan gambar referensi atau visual generik.');
  }

  function showEmpty(message, detail, loading = false) {
    $('main-image').hidden = true;
    $('ambient-image').hidden = true;
    $('image-empty').hidden = false;
    $('image-empty').classList.toggle('is-loading', loading);
    const heading = document.createElement('h2');
    heading.textContent = message;
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    $('image-empty').replaceChildren(heading, paragraph);
    body.dataset.imageState = loading ? 'loading' : 'missing';
  }

  function preloadAdjacent() {
    [currentIndex - 1, currentIndex + 1].forEach(index => {
      if (!pages[index]) return;
      const variant = variantsFor(pages[index])[0];
      if (!variant || imageCache.has(variant.src)) return;
      const image = new Image();
      image.src = variant.src;
      imageCache.add(variant.src);
    });
  }

  function loadVariant(variant, animate = false) {
    const request = ++imageRequest;
    activeVariant = variant || null;
    $('image-stage').setAttribute('aria-busy', variant ? 'true' : 'false');
    setAssetStatus(variant);
    text('selected-variant-label', variant?.label || 'Belum tersedia');
    if (!variant) {
      $('main-image').removeAttribute('src');
      $('ambient-image').removeAttribute('src');
      const page = currentPage();
      const title = page.kind === 'shot' ? `Aset ${page.id} belum terpasang` : page.kind === 'cover' ? 'Visual pembuka mengikuti kurasi' : 'Hero penutup mengikuti kurasi';
      showEmpty(title, 'Gambar hasil generate yang dipilih belum dipetakan ke halaman ini. Tidak ada gambar pengganti yang ditetapkan otomatis.');
      animateAmbient();
      return;
    }
    selectedVariants.set(currentPage().id, variant.id);
    showEmpty('Memuat visual…', variant.sourceTitle || variant.label, true);
    const image = $('main-image');
    let loaded = false;
    image.alt = variant.alt;
    image.onload = () => {
      if (loaded || request !== imageRequest || activeVariant?.id !== variant.id) return;
      loaded = true;
      image.hidden = false;
      $('image-empty').hidden = true;
      $('image-empty').classList.remove('is-loading');
      $('image-stage').setAttribute('aria-busy','false');
      body.dataset.imageState = 'ready';
      $('ambient-image').src = variant.src;
      $('ambient-image').hidden = false;
      if (animate && motionEnabled && typeof image.animate === 'function') {
        transitionAnimations.push(image.animate([{opacity:.15},{opacity:1}],{duration:180,easing:'ease-out'}));
      }
      animateAmbient();
      preloadAdjacent();
    };
    image.onerror = () => {
      if (request !== imageRequest) return;
      $('image-stage').setAttribute('aria-busy','false');
      showEmpty('File gambar belum tersedia', 'Pilih alternatif lain jika tersedia, atau lengkapi file sumber shot ini. Gambar tidak diganti otomatis.');
      setAssetStatus(variant,true);
      animateAmbient();
    };
    image.src = variant.src;
    if (image.complete && image.naturalWidth > 0) image.onload();
  }

  function selectVariant(id) {
    const variant = currentVariants.find(item => item.id === id);
    if (!variant || activeVariant?.id === id) return;
    loadVariant(variant,true);
    updateVariantButtons();
    text('scene-announcement', `${currentPage().id}, ${variant.label}. Visual berubah pada shot yang sama.`);
  }

  function updateVariantButtons() {
    $('alternatives').querySelectorAll('button').forEach(button => {
      const selected = button.dataset.variantId === activeVariant?.id;
      button.classList.toggle('selected',selected);
      button.setAttribute('aria-pressed',String(selected));
    });
  }

  function renderAlternatives() {
    $('alternatives').replaceChildren();
    text('visual-count', `${currentVariants.length} visual`);
    if (!currentVariants.length) {
      const note = document.createElement('p');
      note.className = 'alternatives-empty';
      note.textContent = 'Main dan alternatif belum dipetakan.';
      $('alternatives').append(note);
      return;
    }
    currentVariants.forEach((variant,index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'alternative-button';
      button.dataset.variantId = variant.id;
      button.setAttribute('aria-label', `${variant.label}: ${variant.sourceTitle || variant.alt}`);
      button.title = `${variant.label} — ${variant.sourceTitle || currentPage().id}`;
      const thumbnail = document.createElement('img');
      thumbnail.alt = '';
      thumbnail.src = variant.src;
      thumbnail.loading = index === 0 ? 'eager' : 'lazy';
      thumbnail.draggable = false;
      thumbnail.onerror = () => { thumbnail.classList.add('thumbnail-missing'); thumbnail.alt = 'Thumbnail tidak tersedia'; };
      const title = document.createElement('span');
      title.className = 'variant-label';
      title.textContent = variant.label;
      const note = document.createElement('span');
      note.className = 'variant-note';
      note.textContent = variant.approvalStatus === 'approved' ? 'Disetujui' : 'Untuk review';
      const labels = document.createElement('span');
      labels.className = 'variant-copy';
      labels.append(title,note);
      button.append(thumbnail,labels);
      button.addEventListener('click',() => selectVariant(variant.id));
      $('alternatives').append(button);
    });
    updateVariantButtons();
  }

  function renderInfo(page) {
    if (page.kind !== 'shot') {
      const data = page.kind === 'cover' ? storyboard.cover || {} : storyboard.closing || {};
      text('scene-description', data.description || data.statement || '');
      text('story-purpose', data.description || data.statement || '');
      text('shot-action','');
      text('camera-movement','');
      text('shot-transition','');
      text('production-reason','');
      if ($('content-notes')) $('content-notes').remove();
      return;
    }
    const shot = page.shot;
    text('scene-description',shot.storytelling);
    text('story-purpose',shot.storytelling);
    text('shot-action',shot.action);
    text('camera-movement',shot.cameraMovement);
    text('shot-transition',shot.transition);
    text('production-reason',shot.productionReason || shot.methodReason || 'Metode produksi belum ditetapkan.');
    if ($('content-notes')) $('content-notes').remove();
    if (Array.isArray(shot.contentNotes) && shot.contentNotes.length && $('shot-info')) {
      const note = document.createElement('div');
      note.id = 'content-notes';
      note.className = 'content-note';
      const heading = document.createElement('h3');
      heading.textContent = 'Catatan review';
      const paragraph = document.createElement('p');
      paragraph.textContent = shot.contentNotes.join(' ');
      note.append(heading,paragraph);
      $('shot-info').append(note);
    }
  }

  function renderShotNavigation(page) {
    $('shot-navigation').replaceChildren();
    $('shot-navigation').hidden = page.kind !== 'shot';
    if (page.kind !== 'shot') return;
    page.shot.scene.shots.forEach(shot => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `shot-link${shot.id === page.id ? ' active' : ''}`;
      button.textContent = padded(shot.number);
      button.setAttribute('aria-label',`${shot.id}: ${shot.title}`);
      button.title = `${shot.id} · ${shot.title}`;
      if (shot.id === page.id) button.setAttribute('aria-current','step');
      button.addEventListener('click',() => goToId(shot.id));
      $('shot-navigation').append(button);
    });
  }

  function renderNavigation(page) {
    text('page-number',padded(currentIndex + 1));
    text('page-total',padded(pages.length));
    $('previous-button').disabled = currentIndex === 0;
    $('next-button').disabled = currentIndex === pages.length - 1;
    if ($('deck-progress')) {
      $('deck-progress').setAttribute('aria-valuemin','1');
      $('deck-progress').setAttribute('aria-valuemax',String(pages.length));
      $('deck-progress').setAttribute('aria-valuenow',String(currentIndex + 1));
      if ($('deck-progress').firstElementChild) $('deck-progress').firstElementChild.style.width = `${(currentIndex + 1) / pages.length * 100}%`;
    }
    $('chapter-navigation').querySelectorAll('button').forEach(button => {
      const selected = page.kind === 'shot' && button.dataset.sceneId === page.shot.scene.id;
      button.classList.toggle('active',selected);
      if (selected) button.setAttribute('aria-current','step');
      else button.removeAttribute('aria-current');
    });
    $('index-list').querySelectorAll('button').forEach(button => {
      const selected = button.dataset.shotId === page.id;
      button.classList.toggle('active',selected);
      if (selected) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    renderShotNavigation(page);
  }

  function renderPage(index, announce = false) {
    currentIndex = index;
    const page = currentPage();
    const isShot = page.kind === 'shot';
    text('summary-label',isShot ? 'Visual storytelling' : page.kind === 'closing' ? 'Director’s Statement' : 'Tujuan presentasi');
    body.dataset.pageKind = page.kind;
    body.dataset.pageId = page.id;
    body.dataset.scene = isShot ? page.shot.scene.id : page.kind;
    hidden('cover-label',page.kind !== 'cover');
    hidden('closing-label',page.kind !== 'closing');
    hidden('shot-info',!isShot);
    hidden('panel-toggle',!isShot);
    if (isShot) {
      const shot = page.shot;
      text('scene-title',shot.title);
      text('scene-eyebrow',`SCENE ${padded(shot.scene.number)} / SHOT ${padded(shot.number)}`);
      text('scene-name',shot.scene.title);
      text('shot-id',shot.id);
      text('shot-within-scene',`SHOT ${padded(shot.number)} / ${padded(shot.scene.shots.length)}`);
      text('film-range',`${shot.scene.filmRangeLabel} · Timeline scene`);
      text('production-badge',`${shot.productionMethod || shot.production || 'Perlu ditetapkan'} · Usulan`);
      if ($('production-badge')) $('production-badge').dataset.method = shot.productionMethod || shot.production || '';
      text('duration-value',shot.durationLabel || 'Belum dikunci');
    } else {
      const data = page.kind === 'cover' ? storyboard.cover || {} : storyboard.closing || {};
      text('scene-title',data.title || storyboard.title || 'MOICARE');
      text('scene-eyebrow',data.eyebrow || (page.kind === 'cover' ? 'VISUAL DIRECTOR’S DECK' : 'DIRECTOR’S STATEMENT'));
      text('scene-name',page.kind === 'cover' ? `${scenes.length} scene · ${shots.length} main shot` : 'Satu perjalanan, satu esensi');
      text('shot-id',page.kind === 'cover' ? 'MOICARE' : 'DIRECTOR’S STATEMENT');
      text('shot-within-scene',page.kind === 'cover' ? 'TREATMENT FILM' : 'PENUTUP');
      text('film-range',storyboard.filmDurationLabel || 'Timeline kerja · 28 detik');
      text('production-badge',page.kind === 'cover' ? 'Creative & Production Balanced' : 'Usulan statement');
      text('duration-value',page.kind === 'cover' ? 'Presenter mengendalikan deck' : '');
    }
    renderInfo(page);
    renderNavigation(page);
    currentVariants = variantsFor(page);
    const saved = selectedVariants.get(page.id);
    activeVariant = currentVariants.find(item => item.id === saved) || currentVariants.find(item => item.role === 'main') || currentVariants[0] || null;
    renderAlternatives();
    loadVariant(activeVariant);
    applyPanelState();
    closeFocus();
    if (announce) {
      text('scene-announcement',isShot ? `${currentIndex + 1} dari ${pages.length}. ${page.shot.scene.title}. ${page.id}. ${page.shot.title}.` : `${currentIndex + 1} dari ${pages.length}. ${page.kind === 'cover' ? 'Pembuka deck' : 'Director’s Statement'}.`);
    }
    try { history.replaceState(null,'',`#${page.id}`); } catch (_) {}
  }

  function navigate(index) {
    index = Math.max(0,Math.min(pages.length - 1,Number(index)));
    if (!Number.isInteger(index) || index === currentIndex) return;
    const oldPage = currentPage();
    const direction = index > currentIndex ? 1 : -1;
    const targetPage = pages[index];
    const sameScene = oldPage.kind === 'shot' && targetPage.kind === 'shot' && oldPage.shot.scene.id === targetPage.shot.scene.id;
    cancelTransitionAnimations();
    renderPage(index,true);
    if (motionEnabled && typeof $('image-stage').animate === 'function') {
      const duration = sameScene ? 380 : 650;
      transitionAnimations.push($('image-stage').animate([
        {opacity:.2,transform:`translate3d(${direction * (sameScene ? 60 : 105)}px,0,0)`},
        {opacity:1,transform:'translate3d(0,0,0)'}
      ],{duration,easing:'cubic-bezier(.22,1,.36,1)'}));
      if ($('scene-copy') && typeof $('scene-copy').animate === 'function') {
        transitionAnimations.push($('scene-copy').animate([
          {opacity:.35,transform:`translate3d(${direction * 18}px,0,0)`},
          {opacity:1,transform:'translate3d(0,0,0)'}
        ],{duration:Math.min(duration,500),easing:'cubic-bezier(.22,1,.36,1)'}));
      }
    }
  }

  function indexForId(id) {
    const value = String(id || '').replace(/^#/,'');
    const direct = pages.findIndex(page => page.id.toLowerCase() === value.toLowerCase());
    if (direct >= 0) return direct;
    const aliases = {discover:'S01',reveal:'S02',explore:'S03',activate:'S04',radiate:'S05'};
    const sceneId = aliases[value.toLowerCase()] || value.toUpperCase();
    return pages.findIndex(page => page.kind === 'shot' && page.shot.scene.id === sceneId);
  }
  const goToId = id => { const index = indexForId(id); if (index >= 0) navigate(index); };

  function applyPanelState() {
    const isShot = currentPage().kind === 'shot';
    const visible = panelOpen || !isShot;
    hidden('shot-information',!visible);
    body.classList.toggle('panel-hidden',!visible);
    if ($('panel-toggle')) {
      $('panel-toggle').setAttribute('aria-expanded',String(visible));
      $('panel-toggle').setAttribute('aria-label',visible ? 'Sembunyikan informasi shot' : 'Tampilkan informasi shot');
    }
  }
  function setMode(nextMode) {
    mode = nextMode;
    body.dataset.mode = mode;
    body.classList.toggle('is-review',mode === 'review');
    panelOpen = true;
    ['presentation','review'].forEach(name => {
      const button = $(`${name}-button`);
      if (button) {
        button.classList.toggle('active',mode === name);
        button.setAttribute('aria-pressed',String(mode === name));
      }
    });
    applyPanelState();
    animateAmbient();
  }

  function updateDepth() {
    const enabled = $('depth-enabled') ? $('depth-enabled').checked : true;
    const strength = Number($('depth-range')?.value || 65) / 100;
    text('depth-value',`${Math.round(strength * 100)}%`);
    body.style.setProperty('--ambient-blur',enabled ? `${(8 + strength * 18).toFixed(2)}px` : '0px');
    body.style.setProperty('--foreground-blur',enabled ? `${(strength * 8).toFixed(2)}px` : '0px');
    body.style.setProperty('--ambient-opacity',enabled ? String(.16 + strength * .15) : '.09');
    body.classList.toggle('dof-off',!enabled);
    if ($('depth-range')) $('depth-range').disabled = !enabled;
  }
  function closeFocus() {
    hidden('focus-popover',true);
    $('focus-button')?.setAttribute('aria-expanded','false');
  }
  function openIndex() {
    closeFocus();
    if (typeof $('index-dialog').showModal === 'function') $('index-dialog').showModal();
    else $('index-dialog').setAttribute('open','');
  }
  function closeIndex() {
    if (typeof $('index-dialog').close === 'function') $('index-dialog').close();
    else $('index-dialog').removeAttribute('open');
  }
  function buildIndex() {
    $('chapter-navigation').replaceChildren();
    $('index-list').replaceChildren();
    scenes.forEach(scene => {
      const chapter = document.createElement('button');
      chapter.type = 'button';
      chapter.className = 'chapter-link';
      chapter.dataset.sceneId = scene.id;
      const number = document.createElement('span');
      number.textContent = padded(scene.number);
      const name = document.createElement('span');
      name.className = 'chapter-name';
      name.textContent = scene.narrative || scene.title;
      chapter.append(number,name);
      chapter.setAttribute('aria-label',`Scene ${padded(scene.number)} — ${scene.title}`);
      chapter.title = scene.title;
      chapter.addEventListener('click',() => goToId(scene.id));
      $('chapter-navigation').append(chapter);
      const section = document.createElement('section');
      section.className = 'index-scene';
      const heading = document.createElement('h3');
      heading.textContent = `${padded(scene.number)} — ${scene.title}`;
      const summary = document.createElement('p');
      summary.className = 'index-summary';
      summary.textContent = `${scene.filmRangeLabel} · ${scene.shots.length} shot · ${scene.narrative || ''}`;
      const links = document.createElement('div');
      links.className = 'index-shots';
      scene.shots.forEach(shot => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'index-shot';
        button.dataset.shotId = shot.id;
        const label = document.createElement('span');
        label.textContent = `${shot.id} · ${shot.title}`;
        const detail = document.createElement('small');
        detail.textContent = `${shot.productionMethod || shot.production || 'Perlu ditetapkan'} · ${shot.durationLabel || 'Belum dikunci'}`;
        button.append(label,detail);
        button.addEventListener('click',() => { closeIndex(); goToId(shot.id); });
        links.append(button);
      });
      section.append(heading,summary,links);
      $('index-list').append(section);
    });
  }

  function bind(id, event, handler, options) { $(id)?.addEventListener(event,handler,options); }
  bind('previous-button','click',() => navigate(currentIndex - 1));
  bind('next-button','click',() => navigate(currentIndex + 1));
  bind('home-button','click',() => navigate(0));
  bind('index-button','click',openIndex);
  bind('close-index-button','click',closeIndex);
  bind('index-home-button','click',() => {closeIndex();navigate(0);});
  bind('index-closing-button','click',() => {closeIndex();navigate(pages.length - 1);});
  bind('presentation-button','click',() => setMode('presentation'));
  bind('review-button','click',() => setMode('review'));
  bind('panel-toggle','click',() => {panelOpen = !panelOpen;applyPanelState();});
  bind('motion-button','click',() => {motionEnabled = !motionEnabled;animateAmbient();notify(motionEnabled ? 'Motion pendukung aktif.' : 'Motion dihentikan. Frame storyboard tetap utuh.');});
  bind('replay-button','click',() => animateAmbient(true));
  bind('focus-button','click',() => {
    const open = $('focus-popover')?.hidden !== false;
    hidden('focus-popover',!open);
    $('focus-button')?.setAttribute('aria-expanded',String(open));
  });
  bind('depth-enabled','change',updateDepth);
  bind('depth-range','input',updateDepth);
  bind('fullscreen-button','click',async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else notify('Layar penuh tidak tersedia. Gunakan kontrol browser perangkat Anda.');
    } catch (_) {notify('Gunakan kontrol layar penuh browser perangkat Anda.');}
  });
  document.addEventListener('fullscreenchange',() => {
    $('fullscreen-button')?.setAttribute('aria-label',document.fullscreenElement ? 'Keluar dari layar penuh' : 'Layar penuh');
  });
  document.addEventListener('pointerdown',event => { if (!event.target.closest('.focus-control')) closeFocus(); });
  $('index-dialog').addEventListener('click',event => {
    if (event.target !== $('index-dialog')) return;
    const box = $('index-dialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeIndex();
  });
  document.addEventListener('keydown',event => {
    if ($('index-dialog').open) return;
    if (event.key === 'Escape') {closeFocus();return;}
    if (event.target.closest('input,textarea,select,[contenteditable=true]') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {event.preventDefault();navigate(currentIndex + 1);}
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {event.preventDefault();navigate(currentIndex - 1);}
    if (event.key === 'Home') {event.preventDefault();navigate(0);}
    if (event.key === 'End') {event.preventDefault();navigate(pages.length - 1);}
    if (event.key.toLowerCase() === 'i') {event.preventDefault();openIndex();}
    if (event.key.toLowerCase() === 'f') {event.preventDefault();$('fullscreen-button')?.click();}
  });

  const interactiveTarget = target => target.closest('button,a,input,select,textarea,dialog,aside,#alternatives,#shot-navigation,#focus-popover,[data-scroll-lock]');
  $('scene-screen').addEventListener('wheel',event => {
    if (event.ctrlKey || interactiveTarget(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * multiplier;
    if (!delta) return;
    event.preventDefault();
    const now = Date.now();
    if (now - wheelLastAt > 190) {wheelAccumulator = 0;wheelTriggered = false;}
    wheelLastAt = now;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {wheelAccumulator = 0;wheelTriggered = false;},190);
    if (wheelTriggered) return;
    wheelAccumulator += delta;
    if (Math.abs(wheelAccumulator) >= 38) {
      wheelTriggered = true;
      navigate(currentIndex + (wheelAccumulator > 0 ? 1 : -1));
    }
  },{passive:false});
  $('scene-screen').addEventListener('pointerdown',event => {
    if (event.pointerType !== 'touch' || interactiveTarget(event.target)) return;
    if (event.isPrimary === false) {touchStart = null;return;}
    touchStart = {x:event.clientX,y:event.clientY,id:event.pointerId};
  });
  $('scene-screen').addEventListener('pointerup',event => {
    if (!touchStart || touchStart.id !== event.pointerId) return;
    const dx = event.clientX - touchStart.x;
    const dy = event.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.35) navigate(currentIndex + (dx < 0 ? 1 : -1));
  });
  $('scene-screen').addEventListener('pointercancel',() => {touchStart = null;});
  document.addEventListener('visibilitychange',() => {
    if (!ambientAnimation) return;
    if (document.hidden) ambientAnimation.pause();
    else if (motionEnabled && mode !== 'review') ambientAnimation.play();
  });
  const honorReducedMotion = event => {
    if (!event.matches) return;
    motionEnabled = false;
    cancelTransitionAnimations();
    animateAmbient();
  };
  if (typeof reducedMotion.addEventListener === 'function') reducedMotion.addEventListener('change',honorReducedMotion);
  else if (typeof reducedMotion.addListener === 'function') reducedMotion.addListener(honorReducedMotion);
  window.addEventListener('hashchange',() => {const index = indexForId(location.hash);if(index >= 0) navigate(index);});

  buildIndex();
  updateDepth();
  setMode('presentation');
  const initialIndex = indexForId(location.hash);
  renderPage(initialIndex >= 0 ? initialIndex : 0);
})();
