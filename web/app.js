'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const els = {
    canvas: $('editorCanvas'), shell: $('canvasShell'), empty: $('emptyState'),
    busy: $('busyOverlay'), busyText: $('busyText'), saveStatus: $('saveStatus'),
    title: $('fileTitle'), pill: $('canvasPill'), toast: $('toast'), list: $('pairList'),
    total: $('totalCount'), marked: $('markedCount'), filtered: $('filteredCount'),
    search: $('search'), warnings: $('warnings'), pos: $('position'), zoomText: $('zoomText'),
    brush: $('brushBtn'), eraser: $('eraserBtn'), size: $('brushSize'), sizeNumber: $('sizeNumber'),
    undo: $('undoBtn'), redo: $('redoBtn'), save: $('saveBtn'), saveNext: $('saveNextBtn'),
    prev: $('prevBtn'), next: $('nextBtn'), opacity: $('opacity'), opacityValue: $('opacityValue'),
    grid: $('gridToggle'), sidebar: $('sidebar'), shade: $('sidebarShade'),
    dialog: $('unsavedDialog'), help: $('helpDialog')
  };
  const ctx = els.canvas.getContext('2d', { alpha: false });
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || sessionStorage.getItem('wheat_mask_token') || '';
  if (token) sessionStorage.setItem('wheat_mask_token', token);
  const HOST_STORE = 'wm_' + location.host + '_';
  function stored(key, defaultValue) { try { return (JSON.parse(localStorage.getItem(HOST_STORE + key)) ?? defaultValue); } catch { return defaultValue; } }
  function setStored(key, value) { try { localStorage.setItem(HOST_STORE + key, JSON.stringify(value)); } catch { /* disabled storage */ } }
  const savedIDs = new Set(stored('saved_ids', []));
  const state = {
    pairs: [], selected: -1, pair: null, loaded: false, loading: false, saving: false,
    image: null, pixels: null, baseline: null, width: 0, height: 0, revision: '',
    grayCanvas: null, grayContext: null, pinkCanvas: null, pinkContext: null,
    differenceCount: 0, undo: [], redo: [], stroke: null, brushSize: 12, tool: 'brush',
    view: 'overlay', opacity: .55, grid: false, scale: 1, tx: 0, ty: 0, dpr: 1,
    cursor: null, pointers: new Map(), drawingID: null, panningID: null,
    lastPenTime: 0, pinch: null, spaceDown: false, renderPending: false, toastTimer: null
  };

  function notify(text, error = false) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = text;
    els.toast.classList.toggle('error', error);
    els.toast.classList.add('show');
    state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), error ? 6000 : 2600);
  }
  function setBusy(yes, text = 'Загрузка…') {
    state.loading = yes;
    els.busy.hidden = !yes;
    els.busyText.textContent = text;
    updateControls();
  }
  function updateControls() {
    const ready = state.loaded && !state.loading;
    const dirty = ready && state.differenceCount > 0;
    els.save.disabled = !dirty || state.saving;
    els.saveNext.disabled = !ready || state.saving || state.selected >= state.pairs.length - 1;
    els.prev.disabled = !ready || state.saving || state.selected <= 0;
    els.next.disabled = !ready || state.saving || state.selected >= state.pairs.length - 1;
    els.undo.disabled = !ready || state.saving || !state.undo.length;
    els.redo.disabled = !ready || state.saving || !state.redo.length;
    els.pos.textContent = state.selected < 0 ? `— / ${state.pairs.length}` : `${state.selected + 1} / ${state.pairs.length}`;
    els.pill.hidden = !ready;
    if (ready) els.pill.textContent = `${state.width} × ${state.height} px · ${state.pair.mask_name}`;
    els.saveStatus.className = 'save-status ' + (dirty ? 'dirty' : state.loaded ? 'saved' : 'idle');
    els.saveStatus.innerHTML = `<span class="status-dot"></span>${dirty ? 'Есть изменения' : state.loaded ? 'Без изменений' : 'Не загружено'}`;
  }
  function setTool(next) {
    state.tool = next;
    els.brush.classList.toggle('active', next === 'brush');
    els.eraser.classList.toggle('active', next === 'eraser');
    scheduleRender();
  }
  function changeSize(n) {
    const value = Math.min(400, Math.max(1, Math.round(Number(n) || 1)));
    state.brushSize = value;
    els.size.value = String(Math.min(120, value));
    els.sizeNumber.value = String(value);
    scheduleRender();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: { 'X-Editor-Token': token, ...(options.headers || {}) }
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json()).error || message; } catch {}
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  function imageFromURL(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не удалось загрузить RGB PNG'));
      img.src = url;
    });
  }
  async function fetchList(refresh = false) {
    const prev = state.pair?.id || stored('last_pair_id', null);
    const res = await api('/api/pairs' + (refresh ? '?refresh=1' : ''));
    const json = await res.json();
    state.pairs = json.pairs || [];
    state.pairs.sort((a,b) => a.identifier.localeCompare(b.identifier, undefined, {numeric: true, sensitivity: 'base'}) || a.mask_path.localeCompare(b.mask_path, undefined, {numeric: true, sensitivity: 'base'}));
    els.total.textContent = state.pairs.length;
    els.marked.textContent = savedIDs.size ? `· ${state.pairs.filter(p => savedIDs.has(p.id)).length} сохранено` : '';
    if (json.warnings?.length) {
      els.warnings.hidden = false;
      els.warnings.replaceChildren();
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `⚠ ${json.warning_count} проблем с файлами`;
      details.append(summary);
      json.warnings.forEach(t => {const p=document.createElement('p');p.textContent=t;details.append(p);});
      els.warnings.append(details);
    } else {
      els.warnings.hidden = true;
    }
    renderList();
    if (!state.pairs.length) {
      state.selected = -1;
      state.loaded = false;
      els.empty.hidden = false;
      updateControls();
      notify('Пары IMAGE + MASK не найдены. Проверьте папку и имена.', true);
    } else {
      const selected = Math.max(0, state.pairs.findIndex(p => p.id === prev));
      if (state.loaded && state.pairs[selected]?.id === state.pair?.id) {
        state.selected = selected;
        updateControls();
        renderList();
      } else {
        await loadPair(selected);
      }
    }
  }
  function renderList() {
    const needle = els.search.value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let count = 0;
    state.pairs.forEach((item, i) => {
      if (needle && !(item.identifier + ' ' + item.image_name + ' ' + item.mask_name + ' ' + item.mask_path).toLocaleLowerCase().includes(needle)) return;
      count++;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pair-item' + (i === state.selected ? ' selected' : '');
      button.dataset.id = item.id;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', i === state.selected ? 'true' : 'false');
      button.title = `${item.mask_path}\nRGB: ${item.image_name}`;
      const idx = document.createElement('div'); idx.className='pair-index'; idx.textContent = String(i + 1).padStart(2, '0');
      const detail = document.createElement('div'); detail.className = 'pair-detail';
      const name = document.createElement('div'); name.className = 'pair-name'; name.textContent = item.identifier;
      const subtitle = document.createElement('div'); subtitle.className = 'pair-sub'; subtitle.textContent = item.mask_name.split('__MASK__').slice(1).join('__MASK__') || item.mask_name;
      detail.append(name, subtitle); button.append(idx,detail);
      if (savedIDs.has(item.id)) {const mark=document.createElement('span');mark.className='pair-mark';mark.textContent='●';mark.title='Сохранено в этом браузере';button.append(mark);}
      button.addEventListener('click', () => { requestNavigation(i); closeSidebar(); });
      fragment.append(button);
    });
    els.list.replaceChildren(fragment);
    els.filtered.textContent = `${count}`;
    if (!count) {
      const empty = document.createElement('div'); empty.style.cssText='padding:18px;color:#819aac;font-size:12px'; empty.textContent='Совпадений не найдено';els.list.append(empty);
    }
  }
  function selectVisible() {
    const button = els.list.querySelector('.pair-item.selected');
    if (button) button.scrollIntoView({block: 'nearest'});
  }

  async function loadPair(index) {
    if (state.loading || state.saving) return false;
    const pair = state.pairs[index];
    if (!pair) return false;
    if (state.stroke) endStroke();
    setBusy(true, 'Загружаем RGB и маску…');
    try {
      const base = `/api/pairs/${encodeURIComponent(pair.id)}`;
      const [image, response] = await Promise.all([
        imageFromURL(`${base}/image?token=${encodeURIComponent(token)}&t=${Date.now()}`),
        api(`${base}/mask.raw`)
      ]);
      const pixels = new Uint8Array(await response.arrayBuffer());
      const w = Number(response.headers.get('X-Image-Width'));
      const h = Number(response.headers.get('X-Image-Height'));
      const revision = response.headers.get('X-Mask-Revision');
      if (w !== pair.width || h !== pair.height || image.naturalWidth !== w || image.naturalHeight !== h || pixels.length !== w * h || !revision) {
        throw new Error('Размеры IMAGE / MASK не совпадают или повреждён ответ сервера');
      }
      state.pair = pair;
      state.selected = index;
      state.loaded = true;
      state.image = image;
      state.pixels = pixels;
      state.baseline = pixels.slice();
      state.width = w; state.height = h; state.revision = revision;
      state.differenceCount = 0;
      state.undo = []; state.redo = [];
      state.cursor = null;
      initLayers();
      fitImage();
      els.empty.hidden = true;
      els.title.textContent = pair.identifier;
      els.title.title = `${pair.image_name}\n${pair.mask_name}`;
      setStored('last_pair_id', pair.id);
      renderList();
      selectVisible();
      return true;
    } catch(e) {
      notify('Ошибка загрузки: ' + e.message, true);
      return false;
    } finally {
      setBusy(false);
      updateControls();
      scheduleRender();
    }
  }

  function initLayers() {
    const w = state.width, h = state.height;
    state.grayCanvas = document.createElement('canvas');
    state.grayCanvas.width = w;state.grayCanvas.height = h;
    state.grayContext = state.grayCanvas.getContext('2d', {willReadFrequently: false});
    state.pinkCanvas = document.createElement('canvas');
    state.pinkCanvas.width = w;state.pinkCanvas.height = h;
    state.pinkContext = state.pinkCanvas.getContext('2d', {willReadFrequently: false});
    updateLayerRegion({x0:0,y0:0,x1:w-1,y1:h-1});
  }
  function updateLayerRegion(rect) {
    const {x0,y0,x1,y1} = rect;
    if (x1 < x0 || y1 < y0 || !state.pixels) return;
    const w = x1-x0+1, h = y1-y0+1;
    const gray = state.grayContext.createImageData(w,h);
    const pink = state.pinkContext.createImageData(w,h);
    let p = 0;
    for(let y = y0; y<=y1; y++) {
      let offset = y * state.width + x0;
      for(let x = 0; x<w; x++,offset++,p+=4) {
        const value = state.pixels[offset];
        gray.data[p] = gray.data[p+1] = gray.data[p+2] = value;
        gray.data[p+3] = 255;
        pink.data[p] = 252; pink.data[p+1] = 72; pink.data[p+2] = 146;
        pink.data[p+3] = value;
      }
    }
    state.grayContext.putImageData(gray,x0,y0);
    state.pinkContext.putImageData(pink,x0,y0);
    scheduleRender();
  }
  function clamp(v,a,b) {return Math.min(b,Math.max(a,v));}
  function sizeCanvas() {
    const oldW = Number(els.canvas.dataset.cssw || 0);
    const oldH = Number(els.canvas.dataset.cssh || 0);
    let anchor;
    if (oldW > 0 && oldH > 0 && state.loaded) {
      anchor = {x:(oldW/2-state.tx)/state.scale,y:(oldH/2-state.ty)/state.scale};
    }
    const w = Math.max(1,els.canvas.clientWidth),h = Math.max(1,els.canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1,2,Math.sqrt(8_000_000/(w*h)));
    state.dpr = dpr;
    els.canvas.width = Math.round(w*dpr);
    els.canvas.height = Math.round(h*dpr);
    els.canvas.dataset.cssw = String(w);els.canvas.dataset.cssh = String(h);
    if (anchor) {state.tx = w/2-anchor.x*state.scale;state.ty = h/2-anchor.y*state.scale;}
    scheduleRender();
  }
  function fitImage() {
    if (!state.loaded) return;
    const w = els.canvas.clientWidth,h=els.canvas.clientHeight;
    state.scale = clamp(Math.min((w-36)/state.width,(h-36)/state.height),.025,64);
    state.tx = (w-state.width*state.scale)/2;
    state.ty = (h-state.height*state.scale)/2;
    scheduleRender();
  }
  function zoomAt(nextScale, x, y) {
    if (!state.loaded) return;
    const s = clamp(nextScale,.025,64);
    const wx=(x-state.tx)/state.scale,wy=(y-state.ty)/state.scale;
    state.scale=s;
    state.tx=x-wx*s; state.ty=y-wy*s;
    scheduleRender();
  }
  function scheduleRender() {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(draw);
  }
  function draw() {
    state.renderPending = false;
    const w=els.canvas.clientWidth,h=els.canvas.clientHeight;
    ctx.setTransform(state.dpr,0,0,state.dpr,0,0);
    ctx.fillStyle = '#0b121b';ctx.fillRect(0,0,w,h);
    if (!state.loaded || !state.image) return;
    ctx.save();
    ctx.translate(state.tx,state.ty);
    ctx.scale(state.scale,state.scale);
    if (state.view !== 'mask') {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.image,0,0,state.width,state.height);
    }
    if (state.view === 'mask') {
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(state.grayCanvas,0,0);
    } else if (state.view === 'overlay') {
      ctx.globalAlpha=state.opacity;
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(state.pinkCanvas,0,0);
      ctx.globalAlpha=1;
    }
    ctx.strokeStyle='#9cb8d5';ctx.globalAlpha=.50;
    ctx.lineWidth=1/state.scale;ctx.strokeRect(0,0,state.width,state.height);
    ctx.globalAlpha=1;
    if(state.grid && state.scale >= 10) {
      const x0=clamp(Math.floor(-state.tx/state.scale),0,state.width),
            x1=clamp(Math.ceil((w-state.tx)/state.scale),0,state.width),
            y0=clamp(Math.floor(-state.ty/state.scale),0,state.height),
            y1=clamp(Math.ceil((h-state.ty)/state.scale),0,state.height);
      ctx.strokeStyle='#d0dfed';ctx.globalAlpha=.26;ctx.lineWidth=.65/state.scale;
      ctx.beginPath();
      for(let x=x0;x<=x1;x++){ctx.moveTo(x, y0);ctx.lineTo(x, y1);}
      for(let y=y0;y<=y1;y++){ctx.moveTo(x0,y);ctx.lineTo(x1,y);}
      ctx.stroke(); ctx.globalAlpha=1;
    }
    ctx.restore();
    if (state.cursor && state.cursor.type !== 'touch') {
      const r=Math.max(3,state.brushSize*state.scale*.5);
      ctx.beginPath();ctx.arc(state.cursor.x,state.cursor.y,r,0,Math.PI*2);
      ctx.strokeStyle='#08121b';ctx.lineWidth=3;ctx.stroke();
      ctx.beginPath();ctx.arc(state.cursor.x,state.cursor.y,r,0,Math.PI*2);
      ctx.strokeStyle=state.tool==='brush'?'#fbfbfb':'#ff819a';ctx.lineWidth=1.6;ctx.stroke();
    }
    els.zoomText.textContent=(state.scale*100>=10?(state.scale*100).toFixed(0):(state.scale*100).toFixed(1))+'%';
  }
  function point(e) {const b=els.canvas.getBoundingClientRect();return {x:e.clientX-b.left,y:e.clientY-b.top};}
  function imagePoint(pos) {return {x:(pos.x-state.tx)/state.scale,y:(pos.y-state.ty)/state.scale};}

  function changePixel(idx, value, stroke) {
    const old=state.pixels[idx];
    if(old===value) return false;
    if(stroke && !stroke.before.has(idx)) stroke.before.set(idx,old);
    const baseline=state.baseline[idx];
    if(old!==baseline) state.differenceCount--;
    if(value!==baseline) state.differenceCount++;
    state.pixels[idx]=value;
    return true;
  }
  function emptyBounds(){return {x0:Infinity,y0:Infinity,x1:-1,y1:-1};}
  function includeBounds(bounds,x,y){bounds.x0=Math.min(bounds.x0,x);bounds.x1=Math.max(bounds.x1,x);bounds.y0=Math.min(bounds.y0,y);bounds.y1=Math.max(bounds.y1,y);}
  function paintDisk(px,py,bounds) {
    const size=state.brushSize, val=state.tool==='brush'?255:0,stroke=state.stroke;
    if(size===1){
      const x=Math.floor(px),y=Math.floor(py);
      if(x>=0 && y>=0 && x<state.width && y<state.height && changePixel(y*state.width+x,val,stroke))includeBounds(bounds,x,y);
      return;
    }
    const radius=size/2, r2=radius*radius;
    const xmin=Math.max(0,Math.floor(px-radius-1)),xmax=Math.min(state.width-1,Math.ceil(px+radius));
    const ymin=Math.max(0,Math.floor(py-radius-1)),ymax=Math.min(state.height-1,Math.ceil(py+radius));
    for(let y=ymin;y<=ymax;y++){
      const dy=y+.5-py,dy2=dy*dy;
      for(let x=xmin;x<=xmax;x++){
        const dx=x+.5-px;
        if(dx*dx+dy2<=r2 && changePixel(y*state.width+x,val,stroke))includeBounds(bounds,x,y);
      }
    }
  }
  function paintSegment(a,b) {
    if(!state.stroke)return;
    const bounds=emptyBounds(),dist=Math.hypot(b.x-a.x,b.y-a.y);
    const step=Math.max(.65, Math.min(5, state.brushSize/3));
    const n=Math.max(1,Math.ceil(dist/step));
    for(let i=1;i<=n;i++){
      const t=i/n;
      paintDisk(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,bounds);
    }
    if(bounds.x1>=bounds.x0)updateLayerRegion(bounds);
    updateControls();
  }
  function beginStroke(pos) {
    if(!state.loaded || state.loading || state.saving)return;
    const where=imagePoint(pos);
    state.stroke={before:new Map(),last:where};
    const bounds=emptyBounds();paintDisk(where.x,where.y,bounds);
    if(bounds.x1>=bounds.x0)updateLayerRegion(bounds);
    updateControls();
  }
  function continueStroke(pos) {
    if(!state.stroke)return;
    const w=imagePoint(pos);
    paintSegment(state.stroke.last,w);
    state.stroke.last=w;
  }
  function endStroke() {
    const stroke=state.stroke;state.stroke=null;
    if(!stroke || !stroke.before.size)return;
    const size=stroke.before.size,indices=new Uint32Array(size),before=new Uint8Array(size);
    let i=0;
    for(const [idx,original] of stroke.before){indices[i]=idx;before[i]=original;i++;}
    state.undo.push({indices,before,after:state.tool==='brush'?255:0});
    if(state.undo.length>50)state.undo.shift();
    state.redo=[];
    updateControls();
  }
  function applyHistory(entry, undoing) {
    const bounds=emptyBounds();
    for(let i=0;i<entry.indices.length;i++){
      const idx=entry.indices[i], val=undoing?entry.before[i]:entry.after;
      if(changePixel(idx,val,null))includeBounds(bounds,idx%state.width,Math.floor(idx/state.width));
    }
    if(bounds.x1>=bounds.x0)updateLayerRegion(bounds);
    updateControls();
  }
  function undo(){if(!state.undo.length || state.loading || state.saving)return;if(state.stroke)endStroke();const e=state.undo.pop();applyHistory(e,true);state.redo.push(e);updateControls();}
  function redo(){if(!state.redo.length || state.loading || state.saving)return;const e=state.redo.pop();applyHistory(e,false);state.undo.push(e);updateControls();}

  // Stylus/mouse paints; touch gestures only navigate the canvas.
  function touchList() {return [...state.pointers.entries()].filter(([id,p])=>p.type==='touch');}
  function initPinch() {
    const t=touchList();
    if(t.length<2){state.pinch=null;return;}
    const [a,b]=[t[0][1],t[1][1]],cx=(a.x+b.x)/2,cy=(a.y+b.y)/2;
    state.pinch={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:state.scale,
      anchor:imagePoint({x:cx,y:cy})};
  }
  function pointerDown(e) {
    if(!state.loaded || state.loading || state.saving)return;
    const p=point(e);
    const type=e.pointerType||'mouse';
    if(type==='pen')state.lastPenTime=Date.now();
    if(type==='touch' && (state.drawingID!==null || Date.now()-state.lastPenTime<270))return;
    els.canvas.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId,{...p,type});
    if(type==='touch') {
      if(touchList().length===2)initPinch();
      state.cursor=null;
    } else if(type==='pen' || (type==='mouse' && e.button===0 && !state.spaceDown)) {
      if(state.drawingID===null){state.drawingID=e.pointerId;beginStroke(p);}
      state.cursor={...p,type};
    } else if(type==='mouse' && (e.button===1 || e.button===2 || state.spaceDown)) {
      state.panningID=e.pointerId;state.cursor=null;
    }
    scheduleRender();
    e.preventDefault();
  }
  function pointerMove(e) {
    const p=point(e),old=state.pointers.get(e.pointerId);
    if(e.pointerType==='pen' && e.pointerId===state.drawingID)state.lastPenTime=Date.now();
    if(old) {
      state.pointers.set(e.pointerId,{...p,type:old.type});
      if(old.type==='touch') {
        const touch=touchList();
        if(touch.length>=2) {
          if(!state.pinch)initPinch();
          const [a,b]=[touch[0][1],touch[1][1]],cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,
                dist=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale=clamp(state.pinch.scale*dist/state.pinch.distance,.025,64);
          state.scale=scale;state.tx=cx-state.pinch.anchor.x*scale;state.ty=cy-state.pinch.anchor.y*scale;
        } else if(touch.length===1) {
          state.tx+=p.x-old.x;state.ty+=p.y-old.y;
        }
        scheduleRender();
      } else if(e.pointerId===state.drawingID){continueStroke(p);state.cursor={...p,type:old.type};scheduleRender();}
      else if(e.pointerId===state.panningID){state.tx+=p.x-old.x;state.ty+=p.y-old.y;scheduleRender();}
    } else if(e.pointerType !== 'touch' && state.loaded) {
      state.cursor={...p,type:e.pointerType || 'mouse'};
      scheduleRender();
    }
    if(old)e.preventDefault();
  }
  function pointerUp(e) {
    if(e.pointerId===state.drawingID && e.pointerType==='pen')state.lastPenTime=Date.now();
    if(e.pointerId===state.drawingID){endStroke();state.drawingID=null;}
    if(e.pointerId===state.panningID)state.panningID=null;
    state.pointers.delete(e.pointerId);
    if(touchList().length>=2)initPinch();else state.pinch=null;
    if(e.pointerType==='touch')state.cursor=null;
    scheduleRender();
  }
  els.canvas.addEventListener('pointerdown', pointerDown);
  els.canvas.addEventListener('pointermove', pointerMove);
  els.canvas.addEventListener('pointerup', pointerUp);
  els.canvas.addEventListener('pointercancel', pointerUp);
  els.canvas.addEventListener('pointerleave', e=>{if(!state.pointers.has(e.pointerId)){state.cursor=null;scheduleRender();}});
  els.canvas.addEventListener('contextmenu',e=>e.preventDefault());
  els.canvas.addEventListener('wheel',e=>{
    if(!state.loaded)return;
    e.preventDefault();const p=point(e);
    const factor=Math.exp(-e.deltaY*(e.ctrlKey?.012:.0017));
    zoomAt(state.scale*factor,p.x,p.y);
  },{passive:false});

  async function saveMask() {
    if(state.stroke)endStroke();
    if(!state.loaded || state.loading || state.saving) return false;
    if(state.differenceCount===0)return true;
    state.saving=true;updateControls();els.busy.hidden=false;els.busyText.textContent='Сохраняем MASK поверх исходного файла…';
    try {
      const res=await api(`/api/pairs/${encodeURIComponent(state.pair.id)}/save`,{
        method:'POST',headers:{'Content-Type':'application/octet-stream','If-Match':`"${state.revision}"`},body:state.pixels
      });
      const result=await res.json();
      if(!result.saved || !result.revision)throw new Error('Сервер не подтвердил сохранение');
      state.revision=result.revision;
      state.baseline.set(state.pixels);
      state.differenceCount=0;
      savedIDs.add(state.pair.id);
      setStored('saved_ids',[...savedIDs]);
      els.marked.textContent=`· ${state.pairs.filter(p=>savedIDs.has(p.id)).length} сохранено`;
      notify(`Сохранено: ${state.pair.mask_name}`);
      renderList();
      return true;
    }catch(e){
      notify('Ошибка сохранения: '+e.message,true);
      if(e.status===409)window.alert('Маска изменилась на компьютере после загрузки. Сохранение отменено, чтобы не затереть чужие изменения. Вы можете перечитать исходную пару через обновление страницы, но несохранённые правки тогда будут потеряны.');
      return false;
    }finally{
      state.saving=false;els.busy.hidden=true;updateControls();
    }
  }
  function askUnsaved() {
    return new Promise(resolve=>{
      let settled=false;
      function finish(choice){if(settled)return;settled=true;els.dialog.close();cleanup();resolve(choice);}
      function onCancel(e){e.preventDefault();finish('cancel');}
      function onClose(){finish('cancel');}
      function save(){finish('save');}function discard(){finish('discard');}function cancel(){finish('cancel');}
      function cleanup(){els.dialog.removeEventListener('cancel',onCancel);els.dialog.removeEventListener('close',onClose);$('saveNav').removeEventListener('click',save);$('discardNav').removeEventListener('click',discard);$('cancelNav').removeEventListener('click',cancel);}
      els.dialog.addEventListener('cancel',onCancel);els.dialog.addEventListener('close',onClose);
      $('saveNav').addEventListener('click',save);$('discardNav').addEventListener('click',discard);$('cancelNav').addEventListener('click',cancel);
      els.dialog.showModal();
    });
  }
  async function requestNavigation(index, alwaysSave=false) {
    if(index<0 || index>=state.pairs.length || index===state.selected || state.loading || state.saving)return false;
    if(state.stroke)endStroke();
    if(state.differenceCount>0){
      let decision=alwaysSave?'save':await askUnsaved();
      if(decision==='cancel')return false;
      if(decision==='save' && !await saveMask())return false;
    }
    return await loadPair(index);
  }
  function closeSidebar() {els.sidebar.classList.remove('open');els.shade.classList.remove('open');}

  els.brush.addEventListener('click',()=>setTool('brush'));
  els.eraser.addEventListener('click',()=>setTool('eraser'));
  els.size.addEventListener('input',()=>changeSize(els.size.value));
  els.sizeNumber.addEventListener('change',()=>changeSize(els.sizeNumber.value));
  els.undo.addEventListener('click',undo);els.redo.addEventListener('click',redo);
  els.save.addEventListener('click',saveMask);
  els.prev.addEventListener('click',()=>requestNavigation(state.selected-1));
  els.next.addEventListener('click',()=>requestNavigation(state.selected+1));
  els.saveNext.addEventListener('click',()=>requestNavigation(state.selected+1,true));
  $('fitBtn').addEventListener('click',fitImage);
  $('zoomIn').addEventListener('click',()=>zoomAt(state.scale*1.5,els.canvas.clientWidth/2,els.canvas.clientHeight/2));
  $('zoomOut').addEventListener('click',()=>zoomAt(state.scale/1.5,els.canvas.clientWidth/2,els.canvas.clientHeight/2));
  els.opacity.addEventListener('input',()=>{state.opacity=Number(els.opacity.value)/100;els.opacityValue.textContent=els.opacity.value+'%';scheduleRender();});
  els.grid.addEventListener('change',()=>{state.grid=els.grid.checked;scheduleRender();});
  document.querySelectorAll('.view-button').forEach(btn=>btn.addEventListener('click',()=>{
    state.view=btn.dataset.view;
    document.querySelectorAll('.view-button').forEach(b=>b.classList.toggle('active',b===btn));
    els.opacity.disabled = state.view !== 'overlay';
    scheduleRender();
  }));
  els.search.addEventListener('input',renderList);
  $('refreshBtn').addEventListener('click',async()=>{
    if(state.differenceCount>0){notify('Сначала сохраните или отмените изменения перед обновлением списка.',true);return;}
    try {await fetchList(true);notify('Список пар обновлён');}catch(e){notify(e.message,true);}
  });
  $('sidebarToggle').addEventListener('click',()=>{els.sidebar.classList.toggle('open');els.shade.classList.toggle('open');});
  els.shade.addEventListener('click',closeSidebar);
  $('helpBtn').addEventListener('click',()=>els.help.showModal());
  $('closeHelp').addEventListener('click',()=>els.help.close());
  els.help.addEventListener('click',e=>{if(e.target===els.help)els.help.close();});
  window.addEventListener('keydown',e=>{
    if(e.key===' ' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){state.spaceDown=true;e.preventDefault();}
    const editing=['INPUT','TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='s'){e.preventDefault();saveMask();return;}
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();return;}
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
    if(editing || e.ctrlKey || e.altKey || e.metaKey || els.help.open || els.dialog.open)return;
    if(e.key==='b'||e.key==='B'){setTool('brush');e.preventDefault();}
    else if(e.key==='e'||e.key==='E'){setTool('eraser');e.preventDefault();}
    else if(e.key==='0'){fitImage();e.preventDefault();}
    else if(e.key==='ArrowLeft'){requestNavigation(state.selected-1);e.preventDefault();}
    else if(e.key==='ArrowRight'){requestNavigation(state.selected+1);e.preventDefault();}
    else if(e.key==='/'){els.search.focus();els.sidebar.classList.add('open');els.shade.classList.add('open');e.preventDefault();}
  });
  window.addEventListener('keyup',e=>{if(e.key===' ')state.spaceDown=false;});
  window.addEventListener('blur',()=>{state.spaceDown=false;if(state.stroke){endStroke();state.drawingID=null;}});
  window.addEventListener('beforeunload',e=>{if(state.differenceCount>0){e.preventDefault();e.returnValue='';}});
  new ResizeObserver(sizeCanvas).observe(els.canvas);

  async function launch(){
    sizeCanvas();
    updateControls();
    if(!token){els.empty.querySelector('h2').textContent='Нужна ссылка с кодом доступа';els.empty.querySelector('p').textContent='Откройте на iPad полный адрес http://IP:8765/?token=… из окна запущенного сервера на компьютере.';notify('Отсутствует токен доступа',true);return;}
    try {await fetchList();}
    catch(e){notify('Сервер недоступен: '+e.message,true);els.empty.querySelector('p').textContent='Убедитесь, что сервер на Windows или Mac запущен и iPad подключён к той же локальной сети.';}
  }
  launch();
})();
