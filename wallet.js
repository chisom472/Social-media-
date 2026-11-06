/* Wallet: balances per currency, bank details (any country), withdrawals, rewards, funding */
(function () {
  const { esc } = DE;

  DE.route('/pay/verify/:ref', async (view, p) => {
    DE.title('Confirming payment');
    view.innerHTML = '<div class="card center" style="max-width:480px;margin:30px auto"><div class="spinner"></div><p>Confirming your payment...</p></div>';
    let r = {};
    for (let i = 0; i < 4; i++) {
      try { r = await DE.get('/pay/verify/' + encodeURIComponent(p.ref)); } catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok) break;
      await new Promise(res => setTimeout(res, 2500));
    }
    const next = { product: '/library', group: '/communities', creator_fee: '/edit-page', support: '/wallet', fund: '/wallet' }[r.purpose] || '/';
    view.innerHTML = '<div class="card center" style="max-width:480px;margin:30px auto">' + (r.ok ? '<h1>✅ Payment successful</h1><p>Thank you! Your payment has been confirmed.</p><a class="btn primary" href="' + next + '">Continue</a>' :
      '<h1>⏳ Payment not confirmed yet</h1><p class="muted">' + esc(r.error || 'If you completed the payment, it can take a minute to show. Check again shortly.') + '</p><button class="btn primary" id="again">Check again</button> <a class="btn" href="/">Home</a>') + '</div>';
    const again = DE.$('#again'); if (again) again.onclick = () => DE.render();
  }, { auth: true });

  const TX_LABEL = { sale: 'Sale', commission: 'Platform fee', withdrawal: 'Withdrawal', refund: 'Refund', reward_sent: 'Reward sent', reward_received: 'Reward received', funding: 'Wallet funding', creator_fee: 'Creator fee', convert_in: 'Converted in', convert_out: 'Converted out', fx_margin: 'Conversion margin', dropship_profit: 'Dropship profit', dropship_fee: 'Dropship fee', class_fee: 'Class fee', staff_pay: 'Pay from the owner', dropship_capital: 'Dropship capital' };
  const pillFor = s => ({ paid: 'ok', processing: 'warn', pending: 'warn', failed: 'bad', rejected: 'bad' }[s] || '');
  const COINS = [['USDT', 'Tron (TRC-20)'], ['USDT', 'Ethereum (ERC-20)'], ['USDT', 'BNB Smart Chain (BEP-20)'], ['USDC', 'Ethereum (ERC-20)'], ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['BNB', 'BNB Smart Chain'], ['SOL', 'Solana'], ['LTC', 'Litecoin'], ['TRX', 'Tron']];
  const countryName = c => (DE.world.countries.find(x => x.code === c) || {}).name || c;

  DE.route('/wallet', async view => {
    DE.title('My wallet');
    const w = await DE.get('/pay/wallet');
    const banks = w.banks || [];
    const bal = w.balances.filter(b => b.balance > 0 || b.currency === w.default_currency);
    const owed = w.fees_due || [];
    const isNG = w.user_country === 'NG' || banks.some(b => b.country === 'NG');
    view.innerHTML = '<div><h1>My wallet</h1>' +
      (owed.length ? '<div class="card warnbox"><b>Fees to pay</b>' + owed.map(f => '<div class="row" style="padding:6px 0"><span class="grow">' + esc(f.note || f.kind) + ' · <b>' + DE.money(f.amount, f.currency) + '</b>' + (f.due_at ? ' <span class="muted small">due ' + esc(String(f.due_at).slice(0, 10)) + '</span>' : '') + '</span><button class="btn sm primary" data-payfee="' + f.id + '">Pay from wallet</button><button class="btn sm" data-payfee-card="' + f.id + '">Pay by card/transfer</button></div>').join('') + '</div>' : '') +
      '<div class="card"><h2>Balances</h2><div class="grid">' + (bal.length ? bal.map(b => '<div class="card flat"><div class="muted small">' + b.currency + '</div><div class="bal">' + DE.money(b.balance, b.currency) + '</div></div>').join('') : '<p class="muted">Nothing here yet. Sell a product, run a paid community, or get supported by fans.</p>') + '</div>' +
      '<p class="muted small">You keep a separate balance for each currency you earn. You can convert between currencies' + (isNG ? ' (for example dollars to naira)' : '') + ' and withdraw to a bank, a mobile-money/fintech app' + (isNG ? ' such as OPay, PalmPay, Kuda or Moniepoint' : '') + ', or a crypto wallet. Platform fee on sales: ' + w.commission + '%.</p>' +
      '<div class="row wrap"><button class="btn primary" id="wd">Withdraw</button><button class="btn" id="conv">Convert currency</button><button class="btn" id="fund">Add money</button><button class="btn amber" id="rw">💚 Reward a follower</button></div></div>' +

      '<div class="card"><h2>Bank & fintech accounts</h2><p class="muted small">Add as many as 5. Banks in any country work. In Nigeria you can use any bank or fintech app (OPay, PalmPay, Kuda, Moniepoint and more). Where our payment partners can reach the account, payouts are automatic; otherwise the owner pays it by hand.</p>' +
      (banks.length ? banks.map(b => '<div class="card flat"><div class="row"><div class="grow"><b>' + esc(b.bank_name) + '</b> ' + (b.is_default ? '<span class="pill ok">default</span>' : '') + '<div>' + esc(b.account_name) + '</div><div class="mono small">' + esc(b.account_number) + (b.swift_bic ? ' · SWIFT ' + esc(b.swift_bic) : '') + '</div><div class="muted small">' + esc(countryName(b.country)) + '</div></div>' + (b.is_default ? '' : '<button class="btn sm" data-default="' + b.id + '">Make default</button>') + '<button class="btn sm danger" data-delbank="' + b.id + '">Remove</button></div></div>').join('') : '<p class="muted">No account added yet.</p>') +
      '<button class="btn" id="addBank">+ Add bank or fintech account</button></div>' +

      '<div class="card"><h2>Crypto wallets</h2><p class="muted small">Withdraw to your own crypto address. Double-check the network: money sent on the wrong network is lost.</p>' +
      (w.crypto_wallets.length ? w.crypto_wallets.map(c => '<div class="row" style="padding:6px 0"><b>' + esc(c.coin) + '</b><span class="muted small">' + esc(c.network) + '</span><span class="mono small grow" style="word-break:break-all">' + esc(c.address) + '</span><button class="btn sm danger" data-delcoin="' + esc(c.coin) + '|' + esc(c.network) + '">Remove</button></div>').join('') : '<p class="muted">No crypto wallet added.</p>') +
      '<button class="btn" id="addCoin">+ Add crypto wallet</button></div>' +

      '<div class="card"><h2>PayPal</h2><p class="muted small">Get paid straight to your PayPal account' + (w.paypal_payouts ? ' (automatic)' : '') + '.</p>' +
      (w.paypal ? '<div class="row"><b class="grow">' + esc(w.paypal) + '</b><button class="btn sm danger" id="delPP">Remove</button></div>' : '') +
      '<button class="btn" id="addPP">' + (w.paypal ? 'Change PayPal email' : '+ Add PayPal email') + '</button></div>' +

      '<div class="card"><h2>Withdrawals</h2>' + (w.withdrawals.length ? '<div class="tablewrap"><table><tr><th>Date</th><th>Amount</th><th>Status</th><th>Note</th></tr>' + w.withdrawals.map(x => '<tr><td>' + DE.timeago(x.created_at) + '</td><td>' + DE.money(x.amount, x.currency) + '</td><td><span class="pill ' + pillFor(x.status) + '">' + esc(x.status) + '</span></td><td>' + esc(x.note || '') + '</td></tr>').join('') + '</table></div>' : '<p class="muted">No withdrawals yet.</p>') + '</div>' +
      (w.supporters.length ? '<div class="card"><h2>My top supporters</h2>' + w.supporters.map(s => '<div class="row" style="padding:4px 0"><a class="grow" href="/u/' + esc(s.username) + '">@' + esc(s.username) + '</a><b>' + DE.money(s.total, s.currency) + '</b><span class="muted small">' + s.times + '×</span></div>').join('') + '</div>' : '') +
      '<div class="card"><h2>History</h2>' + (w.transactions.length ? '<div class="tablewrap"><table><tr><th>When</th><th>Type</th><th>Amount</th><th>Note</th></tr>' + w.transactions.map(t => '<tr><td>' + DE.timeago(t.created_at) + '</td><td>' + esc(TX_LABEL[t.type] || t.type) + '</td><td style="color:' + (t.amount < 0 ? 'var(--danger)' : 'var(--ok)') + '">' + (t.amount > 0 ? '+' : '') + DE.money(t.amount, t.currency) + '</td><td>' + esc(t.note || '') + '</td></tr>').join('') + '</table></div>' : '<p class="muted">Nothing yet.</p>') + '</div></div>';

    const balOptions = () => w.balances.filter(b => b.balance > 0).map(b => '<option value="' + b.currency + '">' + b.currency + ' – ' + DE.money(b.balance, b.currency) + ' available</option>').join('') || '<option value="">No balance yet</option>';

    DE.$$('[data-payfee]').forEach(b => b.onclick = () => DE.busy(b, async () => { await DE.post('/pay/fees/' + b.dataset.payfee + '/pay-wallet'); DE.toast('Paid. Thank you!'); DE.render(); }));
    DE.$$('[data-payfee-card]').forEach(b => b.onclick = () => DE.busy(b, () => DE.checkout({ purpose: 'owner_invoice', invoice_id: b.dataset.payfeeCard })));
    DE.$$('[data-default]').forEach(b => b.onclick = () => DE.busy(b, async () => { await DE.put('/pay/bank/' + b.dataset.default + '/default'); DE.render(); }));
    DE.$$('[data-delbank]').forEach(b => b.onclick = async () => { if (await DE.confirm('Remove this account?', 'Remove')) { await DE.del('/pay/bank/' + b.dataset.delbank).catch(DE.fail); DE.render(); } });
    DE.$$('[data-delcoin]').forEach(b => b.onclick = async () => { const [coin, network] = b.dataset.delcoin.split('|'); if (await DE.confirm('Remove this crypto address?', 'Remove')) { await DE.api('DELETE', '/pay/crypto-wallet', { coin, network }).catch(DE.fail); DE.render(); } });

    // ----- withdraw -----
    DE.$('#wd').onclick = () => {
      if (!banks.length && !w.crypto_wallets.length && !w.paypal) return DE.toast('Add a bank, fintech account or crypto wallet first.', true);
      DE.modal('<h2>Withdraw</h2><label class="f">Pay me through</label><select class="i" id="wmeth">' + (banks.length ? '<option value="bank">Bank / fintech account</option>' : '') + (w.paypal ? '<option value="paypal">PayPal (' + esc(w.paypal) + ')</option>' : '') + (w.crypto_wallets.length ? '<option value="crypto">Crypto wallet</option>' : '') + '</select>' +
        '<div id="wdest"></div><label class="f">Balance to use</label><select class="i" id="wcur">' + balOptions() + '</select>' +
        '<div id="wconv"></div><label class="f">Amount</label><input class="i" id="wamt" type="number" min="0" step="any"><div class="small muted" id="wquote"></div>' +
        '<p class="muted small">Minimum ' + w.min_withdrawal + ' (in the payout currency). ' + (w.auto_payout ? 'Automatic transfer is used where possible.' : 'The owner pays you and marks it paid.') + '</p><div class="err" id="werr"></div>' +
        '<div class="row" style="margin-top:12px"><button class="btn primary" id="wok">Request withdrawal</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
        const dest = m.querySelector('#wdest'), conv = m.querySelector('#wconv');
        const bankOf = () => banks.find(b => String(b.id) === (m.querySelector('#wbank') || {}).value);
        function drawDest() {
          if (m.querySelector('#wmeth').value === 'paypal') {
            dest.innerHTML = ''; conv.innerHTML = '<div class="small muted">Paid in the currency of the balance you select. PayPal supports USD, EUR, GBP and many more (not NGN or KWD).</div>';
          } else if (m.querySelector('#wmeth').value === 'crypto') {
            dest.innerHTML = '<label class="f">Wallet</label><select class="i" id="wcoin">' + w.crypto_wallets.map((c, i) => '<option value="' + i + '">' + esc(c.coin) + ' · ' + esc(c.network) + ' · ' + esc(c.address.slice(0, 8)) + '…</option>').join('') + '</select>';
            conv.innerHTML = '<div class="small muted">Crypto payouts are sent by the owner, usually within a day. The amount is paid in the value of the balance you select.</div>';
          } else {
            dest.innerHTML = '<label class="f">Account</label><select class="i" id="wbank">' + banks.map(b => '<option value="' + b.id + '">' + esc(b.bank_name) + ' · ' + esc(b.account_number) + '</option>').join('') + '</select>';
            dest.querySelector('#wbank').onchange = drawConv; drawConv();
          }
        }
        function drawConv() {
          const b = bankOf(); const cur = m.querySelector('#wcur').value;
          const local = b && (DE.world.countries.find(c => c.code === b.country) || {}).currency;
          if (b && local && local !== cur) conv.innerHTML = '<label class="row"><input type="checkbox" id="wconvChk" checked> Convert to <b>' + local + '</b> and pay into this account in ' + local + '</label>';
          else conv.innerHTML = '';
          const chk = conv.querySelector('#wconvChk'); if (chk) { chk.dataset.to = local; chk.onchange = quote; }
          quote();
        }
        async function quote() {
          const out = m.querySelector('#wquote'); out.textContent = '';
          const chk = conv.querySelector('#wconvChk'); const amt = m.querySelector('#wamt').value; const cur = m.querySelector('#wcur').value;
          if (!chk || !chk.checked || !amt || !cur) return;
          try { const q = await DE.get('/pay/convert/quote?from=' + cur + '&to=' + chk.dataset.to + '&amount=' + encodeURIComponent(amt)); out.textContent = 'You will receive about ' + DE.money(q.out, q.to) + ' (rate includes a ' + q.margin_percent + '% conversion margin).'; } catch (e) { out.textContent = e.message; }
        }
        m.querySelector('#wmeth').onchange = drawDest; m.querySelector('#wcur').onchange = drawConv; m.querySelector('#wamt').oninput = quote;
        drawDest();
        m.querySelector('#wok').onclick = async e => {
          e.target.disabled = true;
          const method = m.querySelector('#wmeth').value; const chk = conv.querySelector('#wconvChk');
          const body = { method, currency: m.querySelector('#wcur').value, amount: m.querySelector('#wamt').value };
          if (method === 'bank') { body.bank_id = m.querySelector('#wbank').value; if (chk && chk.checked) body.convert_to = chk.dataset.to; }
          else if (method === 'crypto') { const c = w.crypto_wallets[+m.querySelector('#wcoin').value]; body.coin = c.coin; body.network = c.network; }
          try { const r = await DE.post('/pay/withdraw', body); DE.toast(r.status === 'processing' ? 'Transfer started!' : 'Request sent. You will be paid shortly.'); close(); DE.render(); }
          catch (ex) { m.querySelector('#werr').textContent = ex.message; e.target.disabled = false; }
        };
      });
    };

    // ----- convert -----
    DE.$('#conv').onclick = () => DE.modal('<h2>Convert currency</h2><label class="f">From</label><select class="i" id="cf">' + balOptions() + '</select><label class="f">Amount</label><input class="i" id="ca" type="number" min="0" step="any"><label class="f">To</label>' + DE.currencySelect('ct', isNG ? 'NGN' : null) + '<div class="small muted" id="cq"></div><div class="err" id="cerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="cgo">Convert</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      const q = async () => { const o = m.querySelector('#cq'); o.textContent = ''; const a = m.querySelector('#ca').value; if (!a) return; try { const r = await DE.get('/pay/convert/quote?from=' + m.querySelector('#cf').value + '&to=' + m.querySelector('#ct').value + '&amount=' + encodeURIComponent(a)); o.textContent = 'You get about ' + DE.money(r.out, r.to) + ' (margin ' + r.margin_percent + '%).'; } catch (e) { o.textContent = e.message; } };
      ['#ca', '#cf', '#ct'].forEach(s => m.querySelector(s).addEventListener(s === '#ca' ? 'input' : 'change', q));
      m.querySelector('#cgo').onclick = async e => { e.target.disabled = true; try { await DE.post('/pay/convert', { from: m.querySelector('#cf').value, to: m.querySelector('#ct').value, amount: m.querySelector('#ca').value }); DE.toast('Converted'); close(); DE.render(); } catch (ex) { m.querySelector('#cerr').textContent = ex.message; e.target.disabled = false; } };
    });

    DE.$('#fund').onclick = () => DE.modal('<h2>Add money to your wallet</h2><div class="row"><div style="flex:1"><label class="f">Amount</label><input class="i" id="famt" type="number" min="1" step="any"></div><div style="flex:1"><label class="f">Currency</label>' + DE.currencySelect('fcur') + '</div></div><div class="row" style="margin-top:12px"><button class="btn primary" id="fok">Continue to payment</button><button class="btn" data-close>Cancel</button></div>', m => {
      m.querySelector('#fok').onclick = e => DE.busy(e.target, () => DE.checkout({ purpose: 'fund', amount: m.querySelector('#famt').value, currency: m.querySelector('#fcur').value }));
    });

    DE.$('#rw').onclick = async () => {
      const fl = await DE.get('/users/' + DE.user.username + '/followers');
      DE.modal('<h2>Reward a dedicated follower</h2><label class="f">Who?</label><select class="i" id="rwu">' + (fl.map(f => '<option value="' + esc(f.username) + '">@' + esc(f.username) + '</option>').join('') || '<option value="">No followers yet</option>') + '</select><label class="f">From balance</label><select class="i" id="rcur">' + balOptions() + '</select><label class="f">Amount</label><input class="i" id="ramt" type="number" min="0" step="any"><label class="f">Message</label><input class="i" id="rmsg" maxlength="200"><div class="err" id="rerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="rok">Send reward</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
        m.querySelector('#rok').onclick = async () => { try { await DE.post('/pay/reward', { to_username: m.querySelector('#rwu').value, currency: m.querySelector('#rcur').value, amount: m.querySelector('#ramt').value, message: m.querySelector('#rmsg').value }); DE.toast('Reward sent 💚'); close(); DE.render(); } catch (ex) { m.querySelector('#rerr').textContent = ex.message; } };
      });
    };

    DE.$('#addPP').onclick = () => DE.modal('<h2>PayPal email</h2><label class="f">Email of your PayPal account</label><input class="i" id="ppe" type="email" value="' + esc(w.paypal || '') + '"><div class="err" id="pperr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="ppok">Save</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#ppok').onclick = async () => { try { await DE.put('/pay/paypal', { email: m.querySelector('#ppe').value }); close(); DE.render(); } catch (ex) { m.querySelector('#pperr').textContent = ex.message; } };
    });
    const dpp = DE.$('#delPP'); if (dpp) dpp.onclick = async () => { await DE.del('/pay/paypal'); DE.render(); };

    DE.$('#addCoin').onclick = () => DE.modal('<h2>Add crypto wallet</h2><label class="f">Coin and network</label><select class="i" id="cn">' + COINS.map((c, i) => '<option value="' + i + '">' + c[0] + ' – ' + c[1] + '</option>').join('') + '<option value="x">Other…</option></select><div id="cother" class="two hidden"><div><label class="f">Coin symbol</label><input class="i" id="cos" maxlength="12"></div><div><label class="f">Network</label><input class="i" id="con"></div></div><label class="f">Wallet address</label><input class="i mono" id="cad" autocomplete="off"><label class="f">Memo / tag (only if required)</label><input class="i" id="cme" maxlength="60"><div class="err" id="cerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="cok">Save</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#cn').onchange = e => m.querySelector('#cother').classList.toggle('hidden', e.target.value !== 'x');
      m.querySelector('#cok').onclick = async () => {
        const v = m.querySelector('#cn').value; const c = v === 'x' ? [m.querySelector('#cos').value, m.querySelector('#con').value] : COINS[+v];
        try { await DE.put('/pay/crypto-wallet', { coin: c[0], network: c[1], address: m.querySelector('#cad').value, memo: m.querySelector('#cme').value }); DE.toast('Saved'); close(); DE.render(); } catch (ex) { m.querySelector('#cerr').textContent = ex.message; }
      };
    });

    DE.$('#addBank').onclick = () => {
      let list = [], provider = null;
      DE.modal('<h2>Add bank or fintech account</h2><label class="f">Country</label>' + DE.countrySelect('bcountry', w.user_country) +
        '<div id="bankPick"></div><label class="f">Account number / IBAN (Kuwait: your IBAN starting with KW)</label><input class="i" id="bnum" autocomplete="off" inputmode="numeric">' +
        '<label class="f">Account holder name</label><input class="i" id="bname"><div class="small muted" id="bnote"></div>' +
        '<details style="margin-top:8px"><summary>International details (optional)</summary><div class="row"><div style="flex:1"><label class="f">SWIFT / BIC</label><input class="i" id="bswift" maxlength="11"></div><div style="flex:1"><label class="f">Sort / routing code</label><input class="i" id="brout"></div></div></details>' +
        '<div class="err" id="berr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="bok">Save account</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
        const pick = m.querySelector('#bankPick');
        async function loadBanks() {
          const cc = m.querySelector('#bcountry').value; pick.innerHTML = ''; if (!cc) return;
          const r = await DE.get('/pay/banks?country=' + cc).catch(() => ({ banks: [] }));
          list = r.banks || []; provider = r.provider;
          pick.innerHTML = '<label class="f">Bank or app</label>' + (list.length
            ? '<select class="i" id="bsel"><option value="">Choose…</option>' + list.map(b => '<option value="' + esc(b.code) + '">' + esc(b.name) + '</option>').join('') + '<option value="__other">My bank is not listed</option></select><div id="bmanW"></div>'
            : '<input class="i" id="bman" placeholder="Type the bank or app name">');
          const sel = pick.querySelector('#bsel');
          if (sel) sel.onchange = () => { if (/^[A-Z]{4}KW[A-Z0-9]{2}/.test(sel.value)) m.querySelector('#bswift').value = sel.value; pick.querySelector('#bmanW').innerHTML = sel.value === '__other' ? '<input class="i" id="bman" placeholder="Type the bank or app name" style="margin-top:6px">' : ''; resolve(); };
        }
        async function resolve() {
          const sel = pick.querySelector('#bsel'); const num = m.querySelector('#bnum').value.replace(/\s+/g, '');
          if (!sel || !sel.value || sel.value === '__other' || num.length < 6) return;
          const r = await DE.post('/pay/bank/resolve', { country: m.querySelector('#bcountry').value, bank_code: sel.value, account_number: num, provider }).catch(() => ({}));
          if (r.account_name) { m.querySelector('#bname').value = r.account_name; m.querySelector('#bnote').textContent = '✔ Account name confirmed by the bank.'; }
          else m.querySelector('#bnote').textContent = 'Could not verify automatically. Type the name exactly as the bank has it.';
        }
        m.querySelector('#bcountry').onchange = loadBanks; m.querySelector('#bnum').onblur = resolve; loadBanks();
        m.querySelector('#bok').onclick = async e => {
          const sel = pick.querySelector('#bsel'); const man = pick.querySelector('#bman');
          const listed = sel && sel.value && sel.value !== '__other';
          e.target.disabled = true;
          try {
            await DE.post('/pay/bank', { country: m.querySelector('#bcountry').value, bank_code: listed ? sel.value : null, provider: listed ? provider : null,
              bank_name: listed ? sel.selectedOptions[0].textContent : (man ? man.value : ''), account_number: m.querySelector('#bnum').value, account_name: m.querySelector('#bname').value, swift_bic: m.querySelector('#bswift').value, routing: m.querySelector('#brout').value });
            DE.toast('Account saved'); close(); DE.render();
          } catch (ex) { m.querySelector('#berr').textContent = ex.message; e.target.disabled = false; }
        };
      });
    };
  }, { auth: true });
})();
