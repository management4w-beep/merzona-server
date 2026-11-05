// ============================================================================
//  Merzona → WhatsApp Bridge
//  A small server that receives quotation data from the Merzona tool
//  (Quotation_Generator.html) every time it's saved, and automatically
//  posts it as a WhatsApp message to the "Tasks" group.
//
//  ⚠️ This uses whatsapp-web.js (an unofficial automation via WhatsApp Web),
//  not the official WhatsApp Cloud API — because the official API cannot
//  send messages to groups at all. This means there is some (small) risk
//  of the number getting banned by WhatsApp/Meta since it's not an
//  officially supported way to use the platform. Use a non-critical number
//  for this (like your existing test number) if you can.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { PDFDocument } = require('pdf-lib');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const GROUP_ID = process.env.GROUP_ID || '';
// مجموعة واتساب جديدة مخصصة للعقود الموقّعة إلكترونيًا (منفصلة عن مجموعة Tasks) - لازم تتضاف
// كمتغير بيئة منفصل بنفس طريقة GROUP_ID (شوف /groups لمعرفة الـid تبعها بعد ما تنشئها).
const CONTRACTS_GROUP_ID = process.env.CONTRACTS_GROUP_ID || '';
// Set this to the actual domain your tool runs on (no trailing slash).
// Set to '*' temporarily if you want to test quickly without CORS restrictions.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://management4w-beep.github.io';
