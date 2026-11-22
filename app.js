// App de asistencia instalable (PWA) de Software Iglesia. Habla con el mismo Apps Script por doPost
// (src/server/Main.gs), que solo atiende el ingreso y las operaciones 'movil.*'.
//
//   1. Conexión: la dirección del servidor (/exec) viene en config.js o en el QR (?api=…) y queda guardada.
//   2. Ingreso con correo y clave (portero o administrador). La sesión se guarda en este teléfono.
//   3. Elegir el tipo de reunión → abre o crea la de HOY.
//   4. Marcar / quitar / visitas. Cada acción lleva un uuid generado aquí y entra a una cola (IndexedDB, o
//      memoria si el navegador la bloquea); se envía al volver la señal y cada 15 s. El servidor es idempotente
//      por ese uuid: reintentar nunca duplica. Cada ~10 s se piden solo los cambios desde la última vez.
// El celular nunca recibe RUT, teléfonos, correos ni datos contables.
(function () {
  'use strict';

  var CLAVES = { api: 'asistencia.api', token: 'asistencia.token', usuario: 'asistencia.usuario', correo: 'asistencia.correo', reunion: 'asistencia.reunion' };
  var ROLES_APP = ['portero', 'admin', 'constructor'];
  var app = document.getElementById('app');
  var estado = {
    api: '', token: '', usuario: null,
    panel: null, porId: {}, desde: '', enviando: false, sinConexion: false, timers: [],
  };

  // ── Utilidades ───────────────────────────────────────────────────
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function leer(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function guardar(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* no crítico */ } }
  function sinTildes(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function nuevoUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  var dispositivo = ('App · ' + (navigator.userAgent || 'celular')).slice(0, 180);

  function aviso(mensaje, tipo) {
    var el = document.createElement('div');
    el.className = 'toast ' + (tipo || '');
    el.textContent = mensaje;
    document.getElementById('avisos').appendChild(el);
    setTimeout(function () { el.remove(); }, tipo === 'error' ? 6000 : 2500);
  }

  // Diálogo simple: devuelve una Promesa con true (aceptar) o false.
  function confirmar(mensaje, textoSi) {
    return new Promise(function (resolver) {
      var d = document.getElementById('dialogo');
      d.innerHTML = '<p style="margin-top:0">' + esc(mensaje) + '</p><div class="pie">' +
        '<button class="btn" data-r="no">Cancelar</button><button class="btn primario" data-r="si">' + esc(textoSi || 'Aceptar') + '</button></div>';
      var listo = false;
      var cerrar = function (v) { if (listo) return; listo = true; d.close(); resolver(v); };
      d.onclick = function (e) { var b = e.target.closest('[data-r]'); if (b) cerrar(b.dataset.r === 'si'); };
      d.onclose = function () { cerrar(false); };
      d.showModal();
    });
  }

  // ── Servidor ─────────────────────────────────────────────────────
  // POST "simple" (texto plano, sin preflight). err.red = no llegó al servidor; err.codigo = 'SESION' | 'PERMISO'.
  function api(nombre, args) {
    return fetch(estado.api, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ nombre: nombre, token: estado.token, args: args || {} }),
    }).then(function (r) {
      if (!r.ok) throw Object.assign(new Error('El servidor respondió con un error (' + r.status + ').'), { red: r.status >= 500 });
      return r.json().catch(function () {
        throw new Error('El sistema no respondió como se esperaba. Revisa la dirección (/exec) y que la implementación tenga acceso "Cualquier usuario".');
      });
    }, function () {
      throw Object.assign(new Error('Sin conexión con el servidor.'), { red: true });
    }).then(function (r) {
      if (r.ok) return r.datos;
      var err = new Error(r.error || 'Error desconocido.');
      err.codigo = r.codigo || null;
      if (err.codigo === 'SESION') sesionVencida(err.message);
      if (err.codigo === 'CAMBIAR_CLAVE') pantallaCambioClave('');
      throw err;
    });
  }
  function seguro(fn) {
    return Promise.resolve().then(fn).catch(function (err) {
      if (err && err.codigo !== 'SESION') aviso(err.message, 'error');
    });
  }

  // ── Cola persistente ─────────────────────────────────────────────
  var Cola = {
    db: null, memoria: [], lista: [],
    abrir: function () {
      return new Promise(function (resolver) {
        try {
          var p = indexedDB.open('software-iglesia-asistencia', 1);
          p.onupgradeneeded = function () { p.result.createObjectStore('cola', { keyPath: 'uuid' }); };
          p.onsuccess = function () { Cola.db = p.result; resolver(); };
          p.onerror = p.onblocked = function () { resolver(); };
        } catch (e) { resolver(); }
      }).then(Cola.cargar);
    },
    almacen: function (modo) { return Cola.db.transaction('cola', modo).objectStore('cola'); },
    cargar: function () {
      if (!Cola.db) { Cola.lista = Cola.memoria.slice(); return Promise.resolve(); }
      return new Promise(function (resolver) {
        try {
          var p = Cola.almacen('readonly').getAll();
          p.onsuccess = function () { Cola.lista = (p.result || []).sort(function (a, b) { return a.creado - b.creado; }); resolver(); };
          p.onerror = function () { resolver(); };
        } catch (e) { Cola.db = null; resolver(); }
      });
    },
    agregar: function (item) {
      Cola.lista.push(item);
      if (!Cola.db) { Cola.memoria.push(item); return Promise.resolve(); }
      return new Promise(function (resolver) {
        try { var p = Cola.almacen('readwrite').put(item); p.onsuccess = resolver; p.onerror = function () { Cola.memoria.push(item); resolver(); }; }
        catch (e) { Cola.memoria.push(item); resolver(); }
      });
    },
    quitar: function (uuids) {
      Cola.lista = Cola.lista.filter(function (x) { return uuids.indexOf(x.uuid) < 0; });
      Cola.memoria = Cola.memoria.filter(function (x) { return uuids.indexOf(x.uuid) < 0; });
      if (!Cola.db) return Promise.resolve();
      return new Promise(function (resolver) {
        try {
          var t = Cola.db.transaction('cola', 'readwrite');
          uuids.forEach(function (u) { t.objectStore('cola').delete(u); });
          t.oncomplete = t.onerror = function () { resolver(); };
        } catch (e) { resolver(); }
      });
    },
  };

  function enviar() {
    if (estado.enviando || !Cola.lista.length || !estado.token) { pintarConexion(); return Promise.resolve(); }
    estado.enviando = true;
    pintarConexion();
    var porReunion = {};
    Cola.lista.forEach(function (x) { (porReunion[x.reunion_id] = porReunion[x.reunion_id] || []).push(x); });
    var reuniones = Object.keys(porReunion);
    var siguiente = function (i) {
      if (i >= reuniones.length) return Promise.resolve();
      var reunionId = reuniones[i];
      var acciones = porReunion[reunionId].slice(0, 200);
      return api('movil.lote', { reunion_id: reunionId, dispositivo: dispositivo, acciones: acciones }).then(function (r) {
        estado.sinConexion = false;
        var rechazadas = r.resultado.filter(function (x) { return !x.ok; });
        if (rechazadas.length) aviso(rechazadas[0].error + (rechazadas.length > 1 ? ' (y ' + (rechazadas.length - 1) + ' más)' : ''), 'error');
        return Cola.quitar(r.resultado.map(function (x) { return x.uuid; })).then(function () {
          if (rechazadas.length && estado.panel && estado.panel.reunion.id === reunionId) return recargarPanel();
        });
      }, function (err) {
        if (err.red) { estado.sinConexion = true; throw err; }
        if (err.codigo === 'SESION') throw err; // queda guardada: se envía al volver a ingresar
        aviso(err.message, 'error');
        return Cola.quitar(acciones.map(function (a) { return a.uuid; }));
      }).then(function () { return siguiente(i + 1); });
    };
    return siguiente(0).catch(function () { /* se reintenta en la próxima vuelta */ }).then(function () {
      estado.enviando = false;
      pintarConexion();
    });
  }

  function pintarConexion() {
    var barra = document.querySelector('[data-conexion]');
    if (!barra) return;
    var n = Cola.lista.length;
    barra.hidden = !n && !estado.sinConexion;
    barra.className = 'conexion ' + (estado.sinConexion ? 'sin' : '');
    barra.textContent = estado.sinConexion ? 'Sin conexión — ' + n + ' ' + (n === 1 ? 'pendiente' : 'pendientes')
      : estado.enviando ? 'Enviando ' + n + '…' : n + ' ' + (n === 1 ? 'pendiente' : 'pendientes');
  }

  function encolar(accion) {
    if (!estado.panel || estado.panel.reunion.soloLectura) return Promise.resolve();
    return Cola.agregar(Object.assign({ uuid: nuevoUuid(), reunion_id: estado.panel.reunion.id, creado: Date.now() }, accion))
      .then(function () { pintarConexion(); enviar(); });
  }

  // ── Pantallas: conexión e ingreso ────────────────────────────────
  // Niño = hasta 12 años (el servidor lo manda en "nino"; las visitas usan la categoría simple Niño).
  function esNino(m) { return m.nino !== undefined ? Boolean(m.nino) : m.categoria === 'NINO'; }

  function marca(subtitulo) {
    return '<div class="marca"><img src="iconos/icono-192.png" alt=""><div><strong>Asistencia</strong>' +
      '<span class="suave">' + esc(subtitulo || 'Software Iglesia') + '</span></div></div>';
  }

  function pantallaConexion(mensaje) {
    app.innerHTML = '<div class="centro"><form class="tarjeta" data-form>' + marca('Conectar con la iglesia') +
      (mensaje ? '<div class="aviso">' + esc(mensaje) + '</div>' : '') +
      '<p class="suave" style="margin-top:0">Escanea el código QR de la iglesia, o pega aquí la dirección del sistema (termina en <b>/exec</b>).</p>' +
      '<label class="campo"><span>Dirección del sistema</span><input name="api" type="url" required placeholder="https://script.google.com/macros/s/…/exec"></label>' +
      '<button class="btn primario ancho" type="submit">Conectar</button></form></div>';
    app.querySelector('[data-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      var url = e.target.elements.api.value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(url)) { aviso('La dirección debe ser la de la Web App y terminar en /exec.', 'error'); return; }
      estado.api = url;
      guardar(CLAVES.api, url);
      pantallaIngreso();
    });
  }

  function pantallaIngreso(mensaje) {
    estado.panel = null;
    app.innerHTML = '<div class="centro"><form class="tarjeta" data-form>' + marca() +
      (mensaje ? '<div class="aviso">' + esc(mensaje) + '</div>' : '') +
      '<label class="campo"><span>Nombre de usuario</span><input name="usuario" type="text" autocomplete="username" autocapitalize="words" required value="' + esc(leer(CLAVES.correo)) + '"></label>' +
      '<label class="campo"><span>Clave</span><input name="clave" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn primario ancho" type="submit">Ingresar</button>' +
      '<p class="suave" style="font-size:13px;margin-bottom:0">Entra con tu nombre y la clave que te entregó el administrador de la iglesia.' +
      (Cola.lista.length ? ' Tienes ' + Cola.lista.length + ' marcas pendientes: se enviarán al ingresar.' : '') + '</p>' +
      '<button class="btn enlace" type="button" data-cambiar-api style="margin-top:8px">Cambiar la dirección del sistema</button></form></div>';
    var form = app.querySelector('[data-form]');
    form.elements[form.elements.usuario.value ? 'clave' : 'usuario'].focus();
    form.querySelector('[data-cambiar-api]').addEventListener('click', function () { pantallaConexion(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var boton = form.querySelector('[type=submit]');
      boton.disabled = true;
      boton.textContent = 'Verificando…';
      api('auth.ingresar', { usuario: form.elements.usuario.value, clave: form.elements.clave.value }).then(function (r) {
        if (ROLES_APP.indexOf(r.usuario.rol) < 0) {
          estado.token = r.token;
          api('auth.salir', {}).catch(function () {});
          throw new Error('Esta app es para porteros. Tu rol no registra asistencia desde el celular.');
        }
        estado.token = r.token;
        estado.usuario = r.usuario;
        guardar(CLAVES.token, r.token);
        guardar(CLAVES.usuario, JSON.stringify(r.usuario));
        guardar(CLAVES.correo, r.usuario.usuario);
        if (r.usuario.debe_cambiar_clave) return pantallaCambioClave(form.elements.clave.value);
        enviar();
        return inicio();
      }).catch(function (err) {
        estado.token = '';
        boton.disabled = false;
        boton.textContent = 'Ingresar';
        aviso(err.red ? 'Sin conexión. Revisa la señal e intenta de nuevo.' : err.message, 'error');
      });
    });
  }

  // Primera vez (o clave provisoria nueva): elige una clave propia antes de continuar.
  function pantallaCambioClave(provisoria) {
    app.innerHTML = '<div class="centro"><form class="tarjeta" data-form>' + marca(estado.usuario ? estado.usuario.nombre : '') +
      '<div class="aviso">Tu clave es provisoria. Elige una clave tuya para continuar: desde ahora solo tú la conocerás.</div>' +
      (provisoria ? '' : '<label class="campo"><span>Clave provisoria</span><input name="actual" type="password" autocomplete="current-password" required></label>') +
      '<label class="campo"><span>Clave nueva (mínimo 8 caracteres)</span><input name="nueva" type="password" autocomplete="new-password" required minlength="8"></label>' +
      '<label class="campo"><span>Repite la clave nueva</span><input name="nueva2" type="password" autocomplete="new-password" required></label>' +
      '<button class="btn primario ancho" type="submit">Guardar mi clave</button></form></div>';
    var form = app.querySelector('[data-form]');
    form.querySelector('input').focus();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.elements.nueva.value !== form.elements.nueva2.value) { aviso('Las claves nuevas no coinciden.', 'error'); return; }
      var boton = form.querySelector('[type=submit]');
      boton.disabled = true;
      api('auth.cambiarClave', { actual: provisoria || form.elements.actual.value, nueva: form.elements.nueva.value }).then(function () {
        estado.usuario.debe_cambiar_clave = false;
        guardar(CLAVES.usuario, JSON.stringify(estado.usuario));
        aviso('Clave guardada. ¡Bienvenido!');
        enviar();
        return inicio();
      }).catch(function (err) {
        boton.disabled = false;
        aviso(err.red ? 'Sin conexión. Revisa la señal e intenta de nuevo.' : err.message, 'error');
      });
    });
  }

  function sesionVencida(mensaje) {
    estado.token = '';
    estado.usuario = null;
    guardar(CLAVES.token, '');
    pantallaIngreso(mensaje || 'Tu sesión venció. Vuelve a ingresar.');
  }

  function salir() {
    confirmar('¿Cerrar la sesión en este teléfono?' + (Cola.lista.length ? ' Hay ' + Cola.lista.length + ' marcas sin enviar: se enviarán cuando vuelvas a ingresar.' : ''), 'Salir')
      .then(function (si) {
        if (!si) return;
        api('auth.salir', {}).catch(function () {});
        guardar(CLAVES.reunion, '');
        sesionVencida('Cerraste tu sesión.');
      });
  }

  function cabecera(titulo, extra) {
    return '<div class="cab"><div><strong>' + esc(titulo) + '</strong><small>' + esc(estado.usuario ? estado.usuario.nombre : '') + '</small></div>' +
      '<div>' + (extra || '') + '<button class="btn chico" data-salir>Salir</button></div></div>' +
      '<div data-conexion hidden></div>';
  }

  // ── Paso 1: elegir la reunión de hoy ─────────────────────────────
  function pantallaTipos() {
    estado.panel = null;
    guardar(CLAVES.reunion, '');
    app.innerHTML = '<div class="contenedor">' + cabecera('Asistencia') +
      '<p class="suave">Elige la reunión de hoy:</p><div data-tipos><div class="cargando">Cargando…</div></div></div>';
    pintarConexion();
    return api('movil.inicio', {}).then(function (d) {
      var cont = app.querySelector('[data-tipos]');
      if (!cont) return;
      cont.innerHTML = d.tipos.length ? d.tipos.map(function (t) {
        return '<button class="grande" data-tipo="' + esc(t.id) + '">' + esc(t.nombre) +
          (t.cerrada ? '<small>Asistencia cerrada</small>' : t.reunion_id ? '<small>Ya abierta hoy</small>' : '') + '</button>';
      }).join('') : '<p class="suave">No hay tipos de reunión activos. Pídele al administrador que los configure.</p>';
    }).catch(function (err) {
      if (err.codigo === 'SESION') return;
      var cont = app.querySelector('[data-tipos]');
      if (cont) cont.innerHTML = '<div class="aviso">' + esc(err.red ? 'Sin conexión: para abrir la reunión se necesita señal la primera vez.' : err.message) + '</div>' +
        '<button class="btn" data-reintentar>Reintentar</button>';
    });
  }

  // ── Paso 2: marcar ───────────────────────────────────────────────
  function montarPanel(p) {
    estado.panel = p;
    estado.desde = p.servidor_ahora;
    estado.porId = {};
    p.miembros.forEach(function (m) { estado.porId[m.id] = m; });
    guardar(CLAVES.reunion, p.reunion.id);
    var r = p.reunion;
    var grupos = r.usa_rangos_etarios ? (p.rangos || []).concat([null]) : [undefined];
    var lectura = r.soloLectura;
    app.innerHTML = '<div class="contenedor">' +
      cabecera(r.titulo, '<button class="btn chico" data-cambiar>Cambiar</button>') +
      (lectura ? '<div class="aviso">' + (r.cerrada ? 'La asistencia de esta reunión ya se cerró.' : 'Esta reunión no es de hoy.') + ' Solo se puede ver.</div>' : '') +
      '<div class="contadores" data-contadores></div>' +
      (lectura ? '' : '<input type="search" class="buscar" data-buscar placeholder="Buscar por nombre…" autocomplete="off">' +
        '<div class="lista" data-por-marcar>' + p.miembros.map(function (m) {
          return '<button class="persona" data-marcar="' + esc(m.id) + '" data-nombre="' + esc(sinTildes(m.nombre)) + '">＋ ' + esc(m.nombre) +
            (esNino(m) ? ' <small>' + esc(m.categoria_nombre || 'Niño') + '</small>' : '') + (m.rango_etario ? ' <small>' + esc(m.rango_etario) + '</small>' : '') + '</button>';
        }).join('') + '</div>') +
      '<h2 class="titulo">Presentes</h2>' +
      grupos.map(function (g) {
        var del = p.miembros.filter(function (m) { return g === undefined || (g === null ? !m.rango_etario : m.rango_etario === g); });
        if (!del.length) return '';
        return '<div data-grupo-presentes>' + (g !== undefined ? '<h3 class="subtitulo">' + esc(g || 'Sin clase asignada') + '</h3>' : '') +
          del.map(function (m) {
            return '<div class="presente" data-presente="' + esc(m.id) + '" hidden><span>' + esc(m.nombre) + '<small data-por></small></span>' +
              (lectura ? '' : '<button class="btn chico enlace" data-quitar="' + esc(m.id) + '">Quitar</button>') + '</div>';
          }).join('') + '</div>';
      }).join('') +
      '<div class="fila-titulo"><h2 class="titulo">Visitas</h2>' + (lectura ? '' : '<button class="btn" data-visita>+ Visita</button>') + '</div>' +
      '<div data-visitas></div>' +
      (lectura ? '' : '<div style="margin:28px 0 12px;text-align:center"><button class="btn peligro" data-cerrar>Cerrar asistencia</button></div>') +
      '</div>';
    var buscar = app.querySelector('[data-buscar]');
    if (buscar) buscar.addEventListener('input', filtrar);
    aplicarPendientes();
    pintarEstado();
    pintarConexion();
  }

  function filtrar() {
    var b = app.querySelector('[data-buscar]');
    var t = b ? sinTildes(b.value).trim() : '';
    app.querySelectorAll('[data-marcar]').forEach(function (x) {
      var m = estado.porId[x.dataset.marcar];
      x.hidden = m.presente || (t && x.dataset.nombre.indexOf(t) < 0);
    });
  }

  function pintarEstado() {
    var p = estado.panel;
    if (!p) return;
    p.miembros.forEach(function (m) {
      var fila = app.querySelector('[data-presente="' + m.id + '"]');
      if (!fila) return;
      fila.hidden = !m.presente;
      fila.querySelector('[data-por]').textContent = m.marcado_por ? ' · ' + m.marcado_por : '';
    });
    app.querySelectorAll('[data-grupo-presentes]').forEach(function (g) { g.hidden = !g.querySelector('[data-presente]:not([hidden])'); });
    filtrar();
    var presentes = p.miembros.filter(function (m) { return m.presente; });
    var adultos = presentes.filter(function (m) { return !esNino(m); }).length;
    var porClase = p.reunion.usa_rangos_etarios ? (p.rangos || []).map(function (n) {
      return { n: n, c: presentes.filter(function (m) { return m.rango_etario === n; }).length };
    }).filter(function (x) { return x.c; }) : [];
    app.querySelector('[data-contadores]').innerHTML =
      '<div><b>' + adultos + '</b><span>Adultos</span></div><div><b>' + (presentes.length - adultos) + '</b><span>Niños</span></div>' +
      '<div><b>' + p.visitas.length + '</b><span>Visitas</span></div><div><b>' + (presentes.length + p.visitas.length) + '</b><span>Total</span></div>' +
      (porClase.length ? '<p class="clases">' + porClase.map(function (x) { return esc(x.n) + ': ' + x.c; }).join(' · ') + '</p>' : '');
    app.querySelector('[data-visitas]').innerHTML = p.visitas.length ? p.visitas.map(function (v) {
      return '<div class="presente"><span>' + esc(v.nombre) + (v.categoria === 'NINO' ? ' <small>Niño</small>' : '') + '</span>' +
        (p.reunion.soloLectura ? '' : '<button class="btn chico enlace" data-quitar-visita="' + esc(v.uuid) + '">Quitar</button>') + '</div>';
    }).join('') : '<p class="suave">Sin visitas todavía.</p>';
  }

  function marcar(id) {
    var m = estado.porId[id];
    if (!m || m.presente) return;
    m.presente = true;
    m.marcado_por = estado.usuario.nombre;
    var b = app.querySelector('[data-buscar]');
    if (b) b.value = '';
    pintarEstado();
    if (navigator.vibrate) navigator.vibrate(15);
    encolar({ tipo: 'marcar', miembro_id: id }).then(function () {
      // Si tiene niños a cargo sin marcar, ofrece marcarlos también de un toque.
      var ninos = estado.panel.miembros.filter(function (x) { return x.apoderado_id === id && !x.presente; });
      if (!ninos.length) return;
      return confirmar('¿Marcar también a ' + ninos.map(function (n) { return n.nombre; }).join(', ') + '?', 'Marcar también').then(function (si) {
        if (!si) return;
        ninos.forEach(function (n) { n.presente = true; n.marcado_por = estado.usuario.nombre; });
        pintarEstado();
        return ninos.reduce(function (pr, n) { return pr.then(function () { return encolar({ tipo: 'marcar', miembro_id: n.id }); }); }, Promise.resolve());
      });
    });
  }

  function quitar(id) {
    var m = estado.porId[id];
    if (!m || !m.presente) return;
    confirmar('¿Quitar a ' + m.nombre + ' de los presentes?', 'Quitar').then(function (si) {
      if (!si) return;
      m.presente = false;
      m.marcado_por = '';
      pintarEstado();
      encolar({ tipo: 'quitar', miembro_id: id });
    });
  }

  function quitarVisita(uuid) {
    var v = estado.panel.visitas.find(function (x) { return x.uuid === uuid; });
    if (!v) return;
    confirmar('¿Quitar la visita de ' + v.nombre + '?', 'Quitar').then(function (si) {
      if (!si) return;
      estado.panel.visitas = estado.panel.visitas.filter(function (x) { return x.uuid !== uuid; });
      pintarEstado();
      encolar({ tipo: 'quitarVisita', visita_uuid: uuid });
    });
  }

  function formVisita() {
    var p = estado.panel;
    var d = document.getElementById('dialogo');
    var invitadores = p.miembros.filter(function (m) { return !esNino(m); });
    d.innerHTML = '<form method="dialog" data-form><h2>Nueva visita</h2>' +
      '<label class="campo"><span>Nombre</span><input name="nombre" list="dl-visitas" required maxlength="200" autocomplete="off"></label>' +
      '<datalist id="dl-visitas">' + p.sugerencias.map(function (s) { return '<option value="' + esc(s.nombre) + '"></option>'; }).join('') + '</datalist>' +
      '<label class="campo"><span>Categoría</span><select name="categoria"><option value="ADULTO">Adulto</option><option value="NINO">Niño</option></select></label>' +
      '<label class="campo"><span>Teléfono (opcional)</span><input name="telefono" type="tel" maxlength="50"></label>' +
      '<label class="campo"><span>Invitado por (opcional)</span><select name="invitado_por_id"><option value="">Nadie en particular</option>' +
        invitadores.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.nombre) + '</option>'; }).join('') + '</select></label>' +
      '<div class="pie"><button class="btn" type="button" data-cancelar>Cancelar</button><button class="btn primario" type="submit">Guardar</button></div></form>';
    var form = d.querySelector('[data-form]');
    d.onclose = null;
    d.onclick = function (e) { if (e.target.closest('[data-cancelar]')) d.close(); };
    form.elements.nombre.addEventListener('change', function () {
      var s = p.sugerencias.find(function (x) { return x.nombre === form.elements.nombre.value; });
      if (s) form.elements.categoria.value = s.categoria;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var nombre = form.elements.nombre.value.trim();
      if (!nombre) { aviso('Escribe el nombre de la visita.', 'error'); return; }
      var uuid = nuevoUuid();
      p.visitas.unshift({ uuid: uuid, nombre: nombre, categoria: form.elements.categoria.value });
      pintarEstado();
      Cola.agregar({ uuid: uuid, reunion_id: p.reunion.id, creado: Date.now(), tipo: 'visita', nombre: nombre,
        categoria: form.elements.categoria.value, telefono: form.elements.telefono.value, invitado_por_id: form.elements.invitado_por_id.value || null })
        .then(function () { pintarConexion(); enviar(); });
      d.close();
      aviso('Visita registrada.');
    });
    d.showModal();
    form.elements.nombre.focus();
  }

  function cerrarAsistencia() {
    var reunionId = estado.panel.reunion.id;
    confirmar('¿Cerrar la asistencia de esta reunión? Los celulares ya no podrán marcar en ella (el administrador puede reabrirla).', 'Cerrar asistencia')
      .then(function (si) {
        if (!si) return;
        return seguro(function () {
          return enviar().then(function () {
            if (Cola.lista.some(function (x) { return x.reunion_id === reunionId; })) {
              throw new Error('Todavía hay marcas sin enviar (sin conexión). Espera a tener señal para cerrar.');
            }
            return api('movil.cerrar', { reunion_id: reunionId });
          }).then(function () {
            aviso('Asistencia cerrada.');
            return pantallaTipos();
          });
        });
      });
  }

  // Lo que todavía está en la cola manda sobre lo que diga el servidor (aún no le llega).
  function aplicarPendientes() {
    var p = estado.panel;
    Cola.lista.filter(function (x) { return p && x.reunion_id === p.reunion.id; }).forEach(function (x) {
      var m = estado.porId[x.miembro_id];
      if (x.tipo === 'marcar' && m) { m.presente = true; m.marcado_por = estado.usuario.nombre; }
      if (x.tipo === 'quitar' && m) m.presente = false;
      if (x.tipo === 'visita' && !p.visitas.some(function (v) { return v.uuid === x.uuid; })) p.visitas.unshift({ uuid: x.uuid, nombre: x.nombre, categoria: x.categoria });
      if (x.tipo === 'quitarVisita') p.visitas = p.visitas.filter(function (v) { return v.uuid !== x.visita_uuid; });
    });
  }

  function recargarPanel() {
    if (!estado.panel) return Promise.resolve();
    var b = app.querySelector('[data-buscar]');
    var texto = b ? b.value : '';
    return api('movil.panel', { reunion_id: estado.panel.reunion.id }).then(function (p) {
      montarPanel(p);
      var b2 = app.querySelector('[data-buscar]');
      if (b2) { b2.value = texto; filtrar(); }
    });
  }

  // Sondeo liviano: solo los cambios desde la última marca de tiempo.
  function sondear() {
    var p = estado.panel;
    if (!p || document.hidden || estado.enviando || !estado.token) return;
    var reunionId = p.reunion.id;
    api('movil.estado', { reunion_id: reunionId, desde: estado.desde }).then(function (e) {
      if (!estado.panel || estado.panel.reunion.id !== reunionId) return;
      estado.sinConexion = false;
      estado.desde = e.servidor_ahora;
      var pendiente = function (f) { return Cola.lista.some(function (x) { return x.reunion_id === reunionId && f(x); }); };
      e.marcas.forEach(function (mc) {
        var m = estado.porId[mc.miembro_id];
        if (!m || pendiente(function (x) { return x.miembro_id === mc.miembro_id; })) return;
        m.presente = mc.presente;
        m.marcado_por = mc.marcado_por;
      });
      e.visitas.forEach(function (v) {
        if (pendiente(function (x) { return x.uuid === v.uuid || x.visita_uuid === v.uuid; })) return;
        estado.panel.visitas = estado.panel.visitas.filter(function (x) { return x.uuid !== v.uuid; });
        if (!v.quitada) estado.panel.visitas.unshift({ uuid: v.uuid, nombre: v.nombre, categoria: v.categoria });
      });
      if (e.soloLectura !== estado.panel.reunion.soloLectura) return recargarPanel();
      pintarEstado();
      pintarConexion();
    }).catch(function (err) {
      if (err.red) { estado.sinConexion = true; pintarConexion(); }
    });
  }

  // ── Eventos ──────────────────────────────────────────────────────
  app.addEventListener('click', function (e) {
    var t = e.target;
    var b;
    if (t.closest('[data-salir]')) { salir(); return; }
    if ((b = t.closest('[data-marcar]'))) { marcar(b.dataset.marcar); return; }
    if ((b = t.closest('[data-quitar]'))) { quitar(b.dataset.quitar); return; }
    if ((b = t.closest('[data-quitar-visita]'))) { quitarVisita(b.dataset.quitarVisita); return; }
    if (t.closest('[data-visita]')) { formVisita(); return; }
    if (t.closest('[data-cerrar]')) { cerrarAsistencia(); return; }
    if (t.closest('[data-cambiar]') || t.closest('[data-reintentar]')) { seguro(pantallaTipos); return; }
    if ((b = t.closest('[data-tipo]'))) {
      b.disabled = true;
      seguro(function () { return api('movil.abrir', { tipo_reunion_id: b.dataset.tipo }).then(montarPanel); })
        .then(function () { b.disabled = false; });
    }
  });
  window.addEventListener('online', function () { estado.sinConexion = false; enviar(); });
  window.addEventListener('offline', function () { estado.sinConexion = true; pintarConexion(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { enviar(); sondear(); } });

  // ── Arranque ─────────────────────────────────────────────────────
  function inicio() {
    var guardada = leer(CLAVES.reunion);
    if (!guardada) return pantallaTipos();
    return api('movil.panel', { reunion_id: guardada }).then(function (p) {
      // Una reunión de otro día o ya cerrada no se retoma: se vuelve a elegir la de hoy.
      if (p.reunion.soloLectura) return pantallaTipos();
      montarPanel(p);
      enviar();
    }).catch(function (err) {
      if (err.codigo === 'SESION') return;
      if (err.red) {
        app.innerHTML = '<div class="centro"><div class="tarjeta">' + marca() +
          '<div class="aviso">Sin conexión. Las marcas que hagas sin señal se guardan, pero para abrir la reunión se necesita señal.</div>' +
          '<button class="btn primario ancho" data-reintentar>Reintentar</button></div></div>';
        return;
      }
      return pantallaTipos();
    });
  }

  function arrancar() {
    // La dirección del servidor: la del QR (?api=…), la ya guardada, o la de config.js.
    var desdeQr = new URLSearchParams(location.search).get('api');
    if (desdeQr) {
      guardar(CLAVES.api, desdeQr);
      history.replaceState(null, '', location.pathname);
    }
    estado.api = leer(CLAVES.api) || (window.CONFIG && CONFIG.API_URL) || '';
    estado.token = leer(CLAVES.token);
    try { estado.usuario = JSON.parse(leer(CLAVES.usuario) || 'null'); } catch (e) { estado.usuario = null; }
    Cola.abrir().then(function () {
      estado.timers.push(setInterval(enviar, 15000));
      estado.timers.push(setInterval(sondear, 10000));
      if (!estado.api) return pantallaConexion();
      if (!estado.token || !estado.usuario) return pantallaIngreso();
      if (estado.usuario.debe_cambiar_clave) return pantallaCambioClave('');
      return inicio();
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* funciona igual, sin modo instalable */ });
  }

  arrancar();
})();
