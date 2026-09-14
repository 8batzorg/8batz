const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

const clean = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const htmlEscape = (value) => clean(value).replace(/[&<>'"]/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[ch]));

const allowedTypes = new Set([
  'Proponer una alianza',
  'Apoyar una iniciativa',
  'Presentar una propuesta',
  'Colaborar de otra forma'
]);

export async function onRequestPost(context) {
  try {
    if (!context.env.TURNSTILE_SECRET_KEY || !context.env.RESEND_API_KEY) {
      console.error('Missing required secrets.');
      return json({ ok: false, message: 'El formulario no está disponible temporalmente.' }, 503);
    }

    const form = await context.request.formData();

    // Honeypot: silently accept likely bot submissions without sending email.
    if (clean(form.get('website'), 200)) {
      return json({ ok: true });
    }

    const nombre = clean(form.get('nombre'), 120);
    const organizacion = clean(form.get('organizacion'), 160);
    const correo = clean(form.get('correo'), 254);
    const telefono = clean(form.get('telefono'), 40);
    const tipo = clean(form.get('tipo'), 80);
    const mensaje = clean(form.get('mensaje'), 5000);
    const consentimiento = clean(form.get('consentimiento'), 20);
    const turnstileToken = clean(form.get('cf-turnstile-response'), 2200);

    if (!nombre || !correo || !tipo || !mensaje || consentimiento !== 'aceptado') {
      return json({ ok: false, message: 'Revisá los campos obligatorios del formulario.' }, 400);
    }
    if (!allowedTypes.has(tipo)) {
      return json({ ok: false, message: 'Seleccioná una forma de colaboración válida.' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      return json({ ok: false, message: 'Ingresá un correo electrónico válido.' }, 400);
    }
    if (!turnstileToken) {
      return json({ ok: false, message: 'Completá la verificación de seguridad.' }, 400);
    }

    const verifyBody = new URLSearchParams();
    verifyBody.set('secret', context.env.TURNSTILE_SECRET_KEY);
    verifyBody.set('response', turnstileToken);
    const remoteIp = context.request.headers.get('CF-Connecting-IP');
    if (remoteIp) verifyBody.set('remoteip', remoteIp);

    const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyBody
    });
    const verify = await verifyResponse.json();

    if (!verifyResponse.ok || !verify.success) {
      console.warn('Turnstile validation failed', verify['error-codes'] || []);
      return json({ ok: false, message: 'La verificación de seguridad venció o no pudo validarse. Intentá nuevamente.' }, 403);
    }

    const safe = {
      nombre: htmlEscape(nombre),
      organizacion: htmlEscape(organizacion || 'No indicada'),
      correo: htmlEscape(correo),
      telefono: htmlEscape(telefono || 'No indicado'),
      tipo: htmlEscape(tipo),
      mensaje: htmlEscape(mensaje).replace(/\n/g, '<br>')
    };

    const text = [
      'Nueva comunicación desde el formulario Colaborá de 8 B\'atz\'',
      '',
      `Nombre: ${nombre}`,
      `Organización / institución: ${organizacion || 'No indicada'}`,
      `Correo: ${correo}`,
      `Teléfono: ${telefono || 'No indicado'}`,
      `Tipo de colaboración: ${tipo}`,
      '',
      'Mensaje:',
      mensaje
    ].join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#2f241d;line-height:1.55">
        <h2 style="color:#5b3219">Nueva propuesta de colaboración</h2>
        <p>Se recibió un mensaje desde <strong>8batz.org</strong>.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;font-weight:bold">Nombre</td><td>${safe.nombre}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold">Organización / institución</td><td>${safe.organizacion}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold">Correo</td><td>${safe.correo}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold">Teléfono</td><td>${safe.telefono}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold">Tipo</td><td>${safe.tipo}</td></tr>
        </table>
        <h3 style="margin-top:24px">Mensaje</h3>
        <p>${safe.mensaje}</p>
        <hr style="border:0;border-top:1px solid #ddd;margin:28px 0">
        <p style="font-size:13px;color:#6d675f">Respondé este correo normalmente para escribirle a la persona que completó el formulario.</p>
      </div>`;

    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': '8Batz-Website/1.0',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({
        from: "8 B'atz' Web <web@mail.8batz.org>",
        to: ['info@8batz.org'],
        reply_to: correo,
        subject: `Nueva colaboración — ${tipo}`,
        html,
        text,
        tags: [{ name: 'source', value: 'colabora_form' }]
      })
    });

    const resendResult = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      console.error('Resend error', resendResponse.status, resendResult);
      return json({ ok: false, message: 'No pudimos enviar tu mensaje en este momento. Intentá nuevamente más tarde.' }, 502);
    }

    return json({ ok: true });
  } catch (error) {
    console.error('Form handler error', error);
    return json({ ok: false, message: 'Ocurrió un error inesperado. Intentá nuevamente.' }, 500);
  }
}

export function onRequestGet() {
  return json({ ok: false, message: 'Método no permitido.' }, 405);
}
