const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { EventEmitter } = require('events');
const secrets = require('./secrets');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'digital-enviro.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
const bus = new EventEmitter(); // internal events (notifications -> sockets/push/email)

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  bio TEXT DEFAULT '',
  avatar TEXT,
  avatar_video TEXT,
  dob TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  location_privacy TEXT DEFAULT 'country',
  signup_country TEXT,
  last_country TEXT,
  role TEXT DEFAULT 'user',
  permissions TEXT DEFAULT '',
  google_sub TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  is_creator INTEGER DEFAULT 0,
  owner_fee_waived INTEGER DEFAULT 0,
  class_fee_override INTEGER,
  creator_fee_override INTEGER,
  interests TEXT DEFAULT '',
  favoured INTEGER DEFAULT 0,
  commission_override REAL,
  restrictions TEXT DEFAULT '',
  restriction_note TEXT,
  token_version INTEGER DEFAULT 0,
  failed_logins INTEGER DEFAULT 0,
  locked_until TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_push INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT DEFAULT '',
  cover TEXT,
  blocks TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS creator_subscriptions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paid_until TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, target_id)
);
CREATE TABLE IF NOT EXISTS groups_ (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT,
  cover TEXT,
  focus TEXT DEFAULT 'mixed',
  billing TEXT DEFAULT 'one_time',
  price INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  slug TEXT,
  slug_changed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON groups_(slug);
CREATE TABLE IF NOT EXISTS group_slug_history (
  slug TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  auto_renew INTEGER DEFAULT 0,
  sub_ref TEXT,
  renew_notified TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE VIEW IF NOT EXISTS active_members AS SELECT * FROM group_members WHERE expires_at IS NULL OR expires_at > datetime('now');
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups_(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'text',
  title TEXT,
  body TEXT DEFAULT '',
  media TEXT,
  media_hash TEXT,
  duration REAL,
  category TEXT,
  tags TEXT DEFAULT '',
  expires_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE TABLE IF NOT EXISTS media_registry (
  hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT,
  original_name TEXT,
  file TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- one reaction per user per post (emoji); a plain 'like' is the heart
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT DEFAULT '❤️',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type, id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id);
CREATE TABLE IF NOT EXISTS post_views (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS interests_score (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  score REAL DEFAULT 0,
  PRIMARY KEY (user_id, tag)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups_(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT DEFAULT 'digital',
  price INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  members_only INTEGER DEFAULT 0,
  file TEXT,
  cover TEXT,
  category TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  buyer_email TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  group_id INTEGER,
  purpose TEXT DEFAULT 'product',
  seller_id INTEGER,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  provider TEXT,
  provider_ref TEXT,
  class_id INTEGER,
  target_id INTEGER,
  auto_renew INTEGER DEFAULT 0,
  proof TEXT,
  proof_note TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  provider TEXT,
  provider_ref TEXT,
  kind TEXT DEFAULT 'support',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  balance INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, currency)
);
CREATE TABLE IF NOT EXISTS wallet_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  ref TEXT,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  country TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  bank_code TEXT,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  swift_bic TEXT,
  routing TEXT,
  extra TEXT,
  provider TEXT,
  recipient_code TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, country, bank_name, account_number)
);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL,
  source TEXT DEFAULT 'auto',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  bank_snapshot TEXT,
  status TEXT DEFAULT 'pending',
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  style TEXT DEFAULT 'info',
  audience TEXT DEFAULT 'all',
  audience_value TEXT DEFAULT '',
  guests INTEGER DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  dismissible INTEGER DEFAULT 1,
  link TEXT,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  kind TEXT DEFAULT 'live',
  starts_at TEXT,
  duration_min INTEGER DEFAULT 60,
  capacity INTEGER,
  price INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  open_to TEXT DEFAULT 'members',
  room TEXT,
  meeting_url TEXT,
  cover TEXT,
  replay_url TEXT,
  reminded INTEGER DEFAULT 0,
  fee_status TEXT DEFAULT 'none',
  ended INTEGER DEFAULT 0,
  access_policy TEXT DEFAULT 'keep',
  access_grace_days INTEGER DEFAULT 0,
  access_applied INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS class_enrollments (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_ref TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, user_id)
);
CREATE TABLE IF NOT EXISTS class_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  media TEXT,
  position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS receiving_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  label TEXT,
  currency TEXT,
  country TEXT,
  bank_name TEXT,
  account_number TEXT,
  account_name TEXT,
  swift_bic TEXT,
  routing TEXT,
  coin TEXT,
  network TEXT,
  address TEXT,
  memo TEXT,
  instructions TEXT,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT,
  model TEXT NOT NULL,
  priority INTEGER DEFAULT 10,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS processed_events (
  id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS paypal_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crypto_wallets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  memo TEXT,
  PRIMARY KEY (user_id, coin, network)
);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  brand_name TEXT NOT NULL,
  logo TEXT,
  tagline TEXT DEFAULT '',
  color TEXT DEFAULT '#2fd89a',
  support_email TEXT,
  default_markup INTEGER DEFAULT 40,
  dropship_mode TEXT DEFAULT 'all',       -- a platform id (printful, printify, cj) or 'all' = the app picks per product and destination
  routing TEXT DEFAULT 'cheapest',        -- when several platforms can do an order: cheapest | fastest
  slug_changed_at TEXT,
  fee_counter INTEGER DEFAULT 0,          -- sales since the owner was last charged (fee every N sales)
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS supplier_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  contact_email TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  api_key_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS supplier_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  kind TEXT DEFAULT 'physical',
  file TEXT,
  cost INTEGER NOT NULL,
  currency TEXT NOT NULL,
  stock INTEGER,
  ships_to TEXT DEFAULT 'ALL',
  shipping_fee INTEGER DEFAULT 0,
  processing_days INTEGER DEFAULT 3,
  category TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sp_sku ON supplier_products(supplier_id, sku);
CREATE TABLE IF NOT EXISTS store_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  markup_percent REAL,
  retail_price INTEGER,
  title TEXT,
  description TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_id, product_id)
);
CREATE TABLE IF NOT EXISTS dropship_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  listing_id INTEGER,
  product_id INTEGER,
  supplier_id INTEGER,
  provider TEXT DEFAULT 'supplier',
  pf_listing_id INTEGER,
  pf_variant_id TEXT,
  source_id TEXT,
  provider_order_id TEXT,
  shipping_method TEXT,
  shipping_name TEXT,
  capital INTEGER,
  qty INTEGER DEFAULT 1,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  ship_to TEXT,
  country TEXT,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  shipping INTEGER DEFAULT 0,
  total INTEGER NOT NULL,
  currency TEXT NOT NULL,
  pay_ref TEXT,
  status TEXT DEFAULT 'awaiting_payment',
  tracking_number TEXT,
  tracking_url TEXT,
  carrier TEXT,
  note TEXT,
  attempts INTEGER DEFAULT 0,
  last_attempt TEXT,
  download_token TEXT,
  settled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_do_status ON dropship_orders(status);
-- automatic dropshipping products. 'sources' lists every platform that can make/ship the product (Printful, Printify, CJ ...);
-- at order time the app picks the best source for the buyer's country.
CREATE TABLE IF NOT EXISTS store_slug_history (
  slug TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pf_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'pod',                -- pod (printed with the store's design) | general (ready-made product)
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  design_url TEXT,
  design_w INTEGER,
  design_h INTEGER,
  design_scale INTEGER DEFAULT 60,
  inside_label INTEGER DEFAULT 0,
  variants TEXT DEFAULT '[]',             -- [{key,name,size,color,color_code,image,price}]
  sources TEXT DEFAULT '[]',              -- [{id,provider,product_id,product_name,placement,extra,variants:{key:{id,cost,currency}}}]
  mockups TEXT DEFAULT '[]',
  images TEXT DEFAULT '[]',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pfl_store ON pf_listings(store_id);
-- money the owner pays to the admin team (lands in the staff member's own wallet, which they withdraw like anyone else)
CREATE TABLE IF NOT EXISTS staff_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source TEXT DEFAULT 'wallet',
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT DEFAULT 'dm',
  name TEXT,
  avatar TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  last_read_id INTEGER DEFAULT 0,
  muted INTEGER DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'text',
  body TEXT DEFAULT '',
  media TEXT,
  reply_to INTEGER,
  edited INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_stars (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,
  text TEXT,
  link TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER,
  target_type TEXT,
  target_id INTEGER,
  reason TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS custom_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  in_menu INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER DEFAULT 1
);
-- money that a user owes the site owner: class-hosting fee or creator subscription
CREATE TABLE IF NOT EXISTS owner_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT DEFAULT 'due',
  due_at TEXT,
  paid_at TEXT,
  order_ref TEXT,
  note TEXT,
  reminded_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_user ON owner_invoices(user_id, status);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  media TEXT,
  media_kind TEXT,
  link_url TEXT NOT NULL,
  cta TEXT DEFAULT 'Learn more',
  placement TEXT DEFAULT 'feed',
  countries TEXT DEFAULT '',
  category TEXT,
  status TEXT DEFAULT 'pending_payment',
  days INTEGER DEFAULT 7,
  starts_at TEXT,
  ends_at TEXT,
  max_impressions INTEGER,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  price INTEGER DEFAULT 0,
  currency TEXT,
  order_ref TEXT,
  reject_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_live ON ads(status, placement);
CREATE TABLE IF NOT EXISTS writeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  placement TEXT DEFAULT 'home_top',
  audience TEXT DEFAULT 'all',
  sort INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  identifier TEXT,
  ok INTEGER,
  country TEXT,
  ua TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT,
  detail TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const DEFAULT_CATEGORIES = [
  'Coding', 'AI Development', 'Prompt Engineering', 'Web Development',
  'Mobile Development', 'Desktop Development', 'Game Development',
  'Photography', 'Picture Editing', 'Video Editing', 'Videography',
  'Graphics Design', 'Cybersecurity', 'Cloud & DevOps', 'Data Science',
  'Blockchain', 'UI/UX Design', 'Digital Marketing', 'Other Tech Skills'
];

const DEFAULT_AI_KNOWLEDGE = `Digital Enviro is a community where people learn, share and earn from tech skills.
- Feed: post text, pictures, videos, songs and 24h stories; comment, like and share. Post owners can see who viewed their posts. A file already published by someone else cannot be re-used; the original owner is shown.
- Creator pages: creators build a page with the in-built builder (headings, text, pictures, video, audio, links, buttons, code, embeds) and can sell products and services.
- Communities: anyone can create a community to share knowledge, sell products or run classes - free or paid, one-time or recurring (weekly, monthly, yearly). Paid memberships activate automatically after payment and can renew automatically.
- Classes: community owners host free or paid live classes (built-in video room) and recorded courses.
- Marketplace: sell digital products and services in any currency; buyers pay by card, bank, mobile money or crypto.
- Dropshipping: sellers open a branded store with their own brand name and logo, pick supplier products, and orders are sent to suppliers automatically.
- Wallet: earnings are kept per currency. Withdraw to any bank in any country, or to a crypto wallet. Members can reward each other from their wallet.
- Chat: WhatsApp-style chats and group chats with replies, reactions, voice notes and files.
- Safety: users can block and unblock anyone who disturbs them, and report content to the site owner.
- Account: forgot password works with any email you registered with.`;

const DEFAULT_SETTINGS = {
  site_name: 'Digital Enviro',
  site_tagline: 'Learn. Share. Earn. Build a legacy.',
  policy: '<h2>Community Policy</h2><p>Be respectful. Only post content you own or have the right to share. No harassment, hate speech, scams, adult content, malware or illegal material. Accounts that break these rules may be suspended or deleted by the site owner.</p><p>You can edit this policy from the Admin Dashboard.</p>',
  announcement: '',
  creator_fee_required: '0',
  creator_fee_amount: '5000',
  creator_fee_currency: 'NGN',
  creator_fee_days: '30',
  platform_commission_percent: '5',
  min_withdrawal: '5',
  default_currency: 'NGN',
  paystack_secret_key: '',
  paystack_currencies: 'NGN,GHS,ZAR,KES,USD',
  flutterwave_secret_key: '',
  flutterwave_webhook_hash: '',
  flutterwave_currencies: 'NGN,GHS,KES,UGX,TZS,ZAR,RWF,XOF,XAF,ZMW,EGP,MAD,USD,GBP,EUR',
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  stripe_currencies: 'ALL',
  paypal_mode: 'live',
  paypal_client_id: '',
  paypal_client_secret: '',
  paypal_webhook_id: '',
  paypal_currencies: 'USD,EUR,GBP,CAD,AUD,JPY,CHF,SEK,NOK,DKK,PLN,CZK,HUF,HKD,SGD,NZD,ILS,MXN,BRL,MYR,PHP,TWD,THB,CNY',
  paypal_payouts_enabled: '0',
  tap_secret_key: '',
  tap_currencies: 'KWD,SAR,AED,BHD,QAR,OMR,EGP,USD',
  wise_api_token: '',
  wise_profile_id: '',
  wise_env: 'live',
  wise_source_currency: 'USD',
  wise_payouts_enabled: '0',
  btcpay_payouts_enabled: '0',
  btcpay_payout_method: 'BTC-CHAIN',
  nowpayments_api_key: '',
  nowpayments_ipn_secret: '',
  nowpayments_currencies: 'ALL',
  btcpay_url: '',
  btcpay_store_id: '',
  btcpay_api_key: '',
  btcpay_webhook_secret: '',
  btcpay_currencies: 'ALL',
  accepted_currencies: 'ALL',
  manual_bank_enabled: '0',
  manual_crypto_enabled: '0',
  manual_for_all: '0',
  renewal_grace_days: '3',
  jitsi_domain: 'meet.jit.si',
  ai_name: 'Enviro AI',
  ai_daily_limit: '30',
  ai_system_prompt: 'You are Enviro AI, the friendly tutor and assistant of the Digital Enviro community. Help people learn coding, AI, prompt engineering, web, mobile and game development, photography, editing, video, graphics design and other tech skills, and help them use every feature of the website. Be accurate, practical and encouraging. Use short steps and examples. If you do not know something, say so.',
  ai_knowledge: DEFAULT_AI_KNOWLEDGE,
  seo_keywords: 'online community, tech forum, learn coding, learn AI, prompt engineering, web development, mobile app development, game development, photography, video editing, graphics design, online classes, free courses, sell digital products, creator platform, earn online, dropshipping store, print on demand, creator economy, Nigeria, Africa, freelancing, tech skills, online learning, reels, live classes, create online store',
  theme_brand: '',
  theme_accent: '',
  custom_css: '',
  footer_html: '',
  hero_title: '',
  hero_text: '',
  nav_links: '[]',
  maintenance_mode: '0',
  maintenance_message: 'We are making improvements. Please check back soon.',
  auto_payout: '0',
  owner_country: '',
  owner_bank_name: '',
  owner_account_number: '',
  owner_account_name: '',
  owner_swift_bic: '',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  story_hours: '24',
  allow_signups: '1',
  min_age: '13',
  reel_max_seconds: '90',
  ads_enabled: '1',
  ads_self_serve: '0',
  ad_price_per_day: '5',
  ad_currency: 'USD',
  ad_auto_approve: '0',
  ad_max_days: '30',
  class_fee_mode: 'off',
  class_fee_amount: '5',
  class_fee_currency: 'USD',
  class_fee_when: 'create',
  class_fee_applies: 'paid',
  class_fee_exempt_favoured: '0',
  sms_enabled: '0',
  sms_account_sid: '',
  sms_auth_token: '',
  sms_from: '',
  push_enabled: '1',
  vapid_public: '',
  vapid_private: '',
  vapid_subject: '',
  email_notify_types: 'payment,sale,order,class,withdrawal,security,announcement,creator',
  theme_mode: 'auto',
  owner_payments_enabled: '1',
  pay_creator_fee_enabled: '1',
  pay_class_fee_enabled: '1',
  pay_ads_enabled: '1',
  creator_fee_timing: 'upfront',
  creator_fee_trigger: 'every_class_end',
  creator_fee_grace_days: '7',
  class_fee_grace_days: '3',
  owner_fee_autodebit: '1',
  owner_fee_overdue_action: 'block_classes',
  fx_auto: '1',
  fx_margin_percent: '1.5',
  fx_url: 'https://open.er-api.com/v6/latest/USD',
  ng_auto_convert: '1',
  printful_enabled: '0',
  printful_api_token: '',
  printful_store_id: '',
  printful_webhook_token: '',
  printify_enabled: '0',
  printify_api_token: '',
  printify_shop_id: '',
  printify_webhook_secret: '',
  cj_enabled: '0',
  cj_api_key: '',
  cj_origin_countries: 'US,CN,GB,DE,FR,AU,CA',
  dropship_auto_confirm: '1',
  pod_default_markup: '60',
  dropship_user_suppliers: '0',
  dropship_fee_every: '2',
  dropship_fee_mode: 'fixed',
  dropship_fee_amount: '1.00',
  dropship_fee_percent: '10',
  dropship_fee_currency: 'USD',
  dropship_fee_grace_days: '7',
  pay_dropship_fee_enabled: '1',
  store_domain: '',
  google_login_enabled: '0',
  google_client_id: ''
};

const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
const insCat = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
DEFAULT_CATEGORIES.forEach(c => insCat.run(c));

const FLAGS = [
  ['marketplace', 'Marketplace & digital products'],
  ['groups', 'Communities'],
  ['chat', 'Chat'],
  ['stories', 'Stories'],
  ['tips', 'Support & rewards'],
  ['creator_pages', 'Creator pages'],
  ['dropshipping', 'Dropshipping stores'],
  ['classes', 'Classes'],
  ['reels', 'Reels (short videos)'],
  ['creator_dashboard', 'Creator dashboard'],
  ['ads', 'Advertising'],
  ['ai', 'AI tutor & assistant']
];
const insFlag = db.prepare('INSERT OR IGNORE INTO feature_flags(key,label,enabled) VALUES(?,?,1)');
FLAGS.forEach(f => insFlag.run(f[0], f[1]));

// Secret values are encrypted at rest (AES-256-GCM, see secrets.js)
const SECRET_SETTINGS = new Set(['paystack_secret_key', 'flutterwave_secret_key', 'flutterwave_webhook_hash', 'stripe_secret_key', 'stripe_webhook_secret', 'paypal_client_secret', 'tap_secret_key', 'wise_api_token',
  'nowpayments_api_key', 'nowpayments_ipn_secret', 'btcpay_api_key', 'btcpay_webhook_secret', 'printful_api_token', 'printful_webhook_token', 'printify_api_token', 'printify_webhook_secret', 'cj_api_key', 'smtp_pass', 'sms_auth_token', 'vapid_private']);

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!r) return '';
  return SECRET_SETTINGS.has(key) ? secrets.decrypt(r.value) : r.value;
}
function setSetting(key, value) {
  const v = SECRET_SETTINGS.has(key) ? secrets.encrypt(value) : String(value);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, v);
}
function allSettings() {
  const o = {};
  db.prepare('SELECT key,value FROM settings').all().forEach(r => (o[r.key] = SECRET_SETTINGS.has(r.key) ? secrets.decrypt(r.value) : r.value));
  return o;
}

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  const username = (process.env.ADMIN_USERNAME || 'owner').toLowerCase();
  if (!email || !password) {
    console.warn('[setup] ADMIN_EMAIL / ADMIN_PASSWORD missing in .env - no admin account created.');
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE role='admin'").get();
  if (existing) return;
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare("INSERT INTO users(username,email,password_hash,display_name,role,is_creator) VALUES(?,?,?,?, 'admin', 1)")
    .run(username, email, hash, 'Digital Enviro');
  console.log('[setup] Admin account created for ' + email);
}

/** Saves an in-app notification and tells the notifier (live socket, web push, email) about it. */
function notify(userId, type, text, link) {
  try {
    const info = db.prepare('INSERT INTO notifications(user_id,type,text,link) VALUES(?,?,?,?)').run(userId, type, String(text).slice(0, 500), link || '');
    bus.emit('notify', { id: info.lastInsertRowid, user_id: userId, type, text: String(text).slice(0, 500), link: link || '' });
  } catch (e) { /* ignore */ }
}

/** Notifies the owner and every staff member who holds a permission (e.g. 'payments_manage'). */
function notifyStaff(perm, type, text, link) {
  db.prepare("SELECT id,role,permissions FROM users WHERE status='active' AND role IN ('admin','staff')").all()
    .filter(u => u.role === 'admin' || String(u.permissions || '').split(',').includes(perm))
    .forEach(u => notify(u.id, type, text, link));
}

module.exports = { db, bus, notifyStaff, SECRET_SETTINGS, getSetting, setSetting, allSettings, ensureAdmin, notify, DEFAULT_SETTINGS };
