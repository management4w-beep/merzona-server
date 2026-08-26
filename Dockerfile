# Railway (and most plain Node hosts) install Node apps without the system libraries
# Chromium needs to actually launch - that's what caused the "error while loading shared
# libraries: libglib-2.0.so.0" crash. This Dockerfile installs a real system Chromium plus
# every native library it depends on, and tells Puppeteer to use that instead of trying to
# download and run its own (incompatible) copy.
FROM node:18-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxrandr2 \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own Chromium download entirely at npm install time - we use the
# apt-installed one above instead (faster build, and avoids the broken bundled copy).
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
# 🔧 2026-08-28: --no-audit مضافة عمدًا هون (مو بس لتسريع التثبيت) - آخر نشرة فشلت بنفس خطأ
# "libglib-2.0.so.0" رغم إنو محتوى هالملف سليم، لأنو Docker/Railway استخدم طبقة (layer) قديمة
# متخزنة بالكاش لخطوة npm install من قبل ما تنضبط PUPPETEER_SKIP_DOWNLOAD/EXECUTABLE_PATH صح.
# تغيير أمر الـRUN هون (ولو بشكل بسيط) يجبر إعادة تنفيذ هالخطوة من الصفر بدل الاعتماد عالطبقة
# القديمة العالقة، فيضمن التثبيت الطازة يستخدم إعدادات كروميوم الصحيحة فعليًا.
RUN npm install --omit=dev --no-audit
COPY . .

CMD ["node", "server.js"]
