(function () {
  'use strict';

  const workflow = PrintWorkflow;
  const department = document.body.dataset.department;
  const $ = id => document.getElementById(id);
  const outgoing = Object.entries(workflow.interfaces).filter(([, definition]) => definition.from === department);
  const fields = {
    orderId: ['注文ID'], requestId: ['依頼ID'], proofId: ['校正ID'],
    product: ['品名'], paper: ['用紙'], quantity: ['部数', 'number'],
    dueDate: ['希望納期', 'date'], rush: ['特急区分', ['通常', '特急']], channel: ['受付経路', ['店頭', '電話', 'メール']], reason: ['理由'], version: ['版番号', 'number'],
    instruction: ['確認事項'], responseDueDate: ['回答期限', 'date'],
    proofDecision: ['校正回答', ['承認', '修正依頼']], comment: ['修正コメント'],
    decision: ['依頼回答', ['承認', '却下']], confirmedDueDate: ['確定納期', 'date'],
    stage: ['工程', workflow.stages], expectedDate: ['完了見込み日', 'date'],
    completedDate: ['完成日', 'date'], goodQuantity: ['良品部数', 'number'],
    shortageQuantity: ['不足部数', 'number'],
    receivedAt: ['受信日時'],
    assignee: ['担当者'],
    paperStatus: ['用紙の状況', ['仮手配', '入庫']], memoDate: ['日付', 'date'], note: ['メモ']
  };
  let events = [];
  let state = workflow.buildState(events);
  // 利用者が入力した項目。CSV取り込みでフォームを作り直すときに引き継ぐ。
  const edited = new Set();
  // 直前のCSV取り込みで新しく登録された注文ID（P-016）。
  let importedOrderIds = new Set();

  // 部数は読み上げで桁を間違えないよう、画面では3桁ごとに区切って表示する（CSVは元の数値のまま）。
  const quantityFields = ['quantity', 'goodQuantity', 'shortageQuantity'];

  function formatCount(value) {
    const number = Number(value);
    return value === '' || value === undefined || !Number.isFinite(number) ? value : number.toLocaleString('ja-JP');
  }

  function copies(value) {
    return formatCount(value) + '部';
  }

  function element(tag, content) {
    const item = document.createElement(tag);
    if (content !== undefined) item.textContent = content;
    return item;
  }

  function option(value, label) {
    const item = element('option', label);
    item.value = value;
    return item;
  }

  function select(name, options) {
    const input = element('select');
    input.name = name;
    const placeholder = option('', options.length ? '選択してください' : '対象データがありません');
    placeholder.disabled = true;
    placeholder.selected = true;
    input.append(placeholder, ...options.map(([value, label]) => option(value, label)));
    return input;
  }

  function show(message, error = false) {
    $('message').textContent = message;
    $('message').dataset.error = String(error);
  }

  function localDate() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function identifier(prefix) {
    return prefix + '-' + Array.from(crypto.getRandomValues(new Uint32Array(3)), number =>
      number.toString(36).padStart(7, '0')).join('');
  }

  // 当初分が完了した注文は、承認済みで未完了の追加製造がある場合だけ進捗を送れる。
  function acceptsProgress(order) {
    return !order.initialFinished || [...state.requests.values()].some(request =>
      request.orderId === order.id && request.type === 'additional' &&
      request.answer === '承認' && !request.finished);
  }

  function orderChoices(type) {
    const orders = [...state.orders.values()];
    if (type === 'reply' || type === 'receipt') {
      return orders.filter(order => [...state.requests.values()].some(request =>
        request.orderId === order.id && !request.answer && (type === 'reply' || !request.receivedAt)));
    }
    // 用紙の仮手配は製造承認の前でも記録できるよう、作業一覧に出ている注文を選べる。
    if (type === 'paperMemo' || type === 'assign') return orders.filter(isListed);
    const available = orders.filter(workflow.availableOrder);
    return type === 'progress' ? available.filter(acceptsProgress) : available;
  }

  function requestChoices(type, order) {
    return [...state.requests.values()]
      .filter(request => order && request.orderId === order.id)
      .filter(request => type === 'receipt' ? !request.answer && !request.receivedAt :
        type === 'reply' ? !request.answer :
        ['order', 'additional'].includes(request.type) && request.answer === '承認' && !request.finished)
      .map(request => [request.requestId, workflow.interfaces[request.type].name + ' · ' +
        (type === 'finish' ? copies(request.targetQuantity) + ' · ' : '') +
        (type === 'reply' && request.dueDate ? '希望納期 ' + request.dueDate + ' · ' : '') +
        (type === 'reply' && request.quantity ? copies(request.quantity) + ' · ' : '') + request.requestId]);
  }

  // 依頼回答の入力欄で、選んだ依頼の種別・希望納期・部数などを承認前に確認できるようにする。
  // 注文変更依頼では、今の注文の値と並べて何が変わるかを示す。
  function renderRequestDetail() {
    const holder = $('request-detail');
    if (!holder) return;
    holder.replaceChildren();
    const requestInput = $('fields').querySelector('[name="requestId"]');
    const request = requestInput && state.requests.get(requestInput.value);
    if (!request) {
      holder.append(element('p', '依頼を選ぶと、依頼種別・希望納期・部数をここに表示します。'));
      holder.className = 'request-detail empty-detail';
      return;
    }
    holder.className = 'request-detail';
    const order = state.orders.get(request.orderId);
    const isChange = request.type === 'change';
    const rows = [
      ['依頼種別', workflow.interfaces[request.type].name],
      ['注文', orderLabel(order)],
      ['希望納期', request.dueDate ? request.dueDate + (isChange ? '（今の納期 ' + order.dueDate + '）' : '') :
        '指定なし（今の納期 ' + order.dueDate + '）'],
      ['部数', request.quantity ? copies(request.quantity) + (isChange ? '（今の部数 ' + copies(order.quantity) + '）' : '') :
        '指定なし（今の部数 ' + copies(order.quantity) + '）']
    ];
    if (isChange) rows.push(['用紙', request.paper + '（今の用紙 ' + order.paper + '）']);
    if (request.type === 'order') rows.push(['特急区分', request.rush || '通常'], ['受付経路', request.channel || '未設定']);
    if (request.reason) rows.push(['依頼の理由', request.reason]);
    holder.append(element('h3', '回答する依頼の内容'));
    const list = element('dl');
    for (const [label, value] of rows) list.append(element('dt', label), element('dd', value));
    holder.append(list);
  }

  function proofChoices(order) {
    return [...state.proofs.values()].filter(proof => order && proof.orderId === order.id && !proof.answer)
      .map(proof => [proof.proofId, '第' + proof.version + '版 · ' + proof.instruction]);
  }

  // 同じ品名の別注文を取り違えないよう、品名には必ず注文IDと用紙を添える。
  function orderLabel(order) {
    return order.product + '（' + order.paper + '）· ' + order.id;
  }

  function productCell(cell, order, sameName) {
    cell.replaceChildren(element('span', order.product));
    if (sameName) {
      const tag = element('span', '同名あり');
      tag.className = 'tag tag-same';
      tag.title = '同じ品名の注文がほかにもあります。注文IDと用紙で確認してください。';
      cell.append(' ', tag);
    }
    const detail = element('div', order.id + ' · ' + order.paper);
    detail.className = 'sub';
    cell.append(detail);
    // 問い合わせ対応で営業に聞き直さなくて済むよう、受付経路（店頭・電話・メール）を出す（P-011）。
    if (order.channel && order.channel !== '未設定') {
      const channel = element('div', '受付：' + order.channel);
      channel.className = 'sub channel';
      cell.append(channel);
    }
  }

  // 用紙の欄に、製造部内メモの仮手配・入庫の最新の日付を添える。
  function paperCell(cell, order) {
    for (const status of ['仮手配', '入庫']) {
      const memo = order.paperMemos.filter(item => item.status === status).at(-1);
      if (!memo) continue;
      const line = element('div', status + ' ' + memo.date + (memo.note ? '（' + memo.note + '）' : ''));
      line.className = 'sub paper-memo';
      line.title = '製造部内メモ（営業部には送りません）';
      cell.append(line);
    }
  }

  function automaticField(type, field) {
    return field === 'updatedAt' || field === 'receivedAt' || (type === 'order' && field === 'orderId') ||
      (['order', 'change', 'cancel', 'additional'].includes(type) && field === 'requestId') ||
      (type === 'proof' && field === 'proofId');
  }

  function inputFor(type, field, order) {
    const [, kind] = fields[field];
    if (field === 'orderId') {
      return select(field, orderChoices(type).map(item => [item.id, orderLabel(item)]));
    }
    if (field === 'requestId') return select(field, requestChoices(type, order));
    if (field === 'proofId') return select(field, proofChoices(order));
    if (Array.isArray(kind)) return select(field, kind.map(value => [value, value]));

    const input = element(field === 'comment' || field === 'instruction' ? 'textarea' : 'input');
    input.name = field;
    if (input.tagName === 'INPUT') input.type = kind || 'text';
    if (input.type === 'number') {
      input.min = ['goodQuantity', 'shortageQuantity'].includes(field) ? '0' : '1';
      input.step = '1';
    }
    if (field === 'completedDate' || field === 'memoDate') input.value = localDate();
    if (field === 'assignee') {
      // これまでに登録した担当者から選べるようにする（新しい名前も入力できる）。
      input.setAttribute('list', 'assignee-names');
      input.maxLength = 30;
      input.autocomplete = 'off';
      if (order) input.value = order.assignee;
    }
    if (field === 'version') {
      const last = [...state.proofs.values()].filter(proof => order && proof.orderId === order.id).at(-1);
      input.value = last ? Number(last.version) + 1 : 1;
    }
    if (type === 'change' && order && ['paper', 'quantity', 'dueDate'].includes(field)) {
      input.value = order[field];
    }
    return input;
  }

  // 今どの操作をしているか分かるよう、登録ボタンの名前を操作の種類に合わせる。
  const actionLabels = {
    reply: '依頼回答を送る',
    receipt: '受信通知を送る',
    proof: '校正確認を送る',
    progress: '製造進捗を通知する',
    delay: '納期遅延を通知する',
    finish: '製造完了を報告する',
    paperMemo: '用紙メモを残す',
    assign: '担当者を登録する'
  };

  // 注文を切り替えるとフォームを作り直すため、注文ID以外の入力は消える。
  // 完了報告では部数の入力途中で取り違えに気づくことがあるので、消える前に確認する。
  let formSnapshot = '';

  function enteredValues() {
    return JSON.stringify([...new FormData($('entry'))].filter(([name]) => name !== 'orderId'));
  }

  function hasUnsavedFinish(type) {
    return type === 'finish' && enteredValues() !== formSnapshot;
  }

  // 長い確認事項を現場で読んでもらえるよう、校正確認依頼の確認事項の欄は横いっぱいにし、
  // ボタンで縦にも大きく広げられるようにする。広げた状態は入力欄を作り直しても保つ。
  let instructionExpanded = false;

  function widenable(label, textarea) {
    label.classList.add('wide');
    textarea.rows = 5;
    const button = element('button');
    button.type = 'button';
    button.className = 'secondary widen';
    const apply = () => {
      textarea.classList.toggle('expanded', instructionExpanded);
      button.textContent = instructionExpanded ? '入力欄を元の大きさに戻す' : '入力欄を広げる';
      button.setAttribute('aria-pressed', String(instructionExpanded));
    };
    button.addEventListener('click', () => {
      instructionExpanded = !instructionExpanded;
      apply();
      textarea.focus();
    });
    apply();
    label.append(button);
  }

  // 完成日の打ち間違いに報告前に気づけるよう、昨日より前の日付には注意を出す（P-023）。
  function isOldCompletedDate(value) {
    return Boolean(value) && value < daysBefore(localDate(), 1);
  }

  function updateCompletedDateWarning() {
    const warning = $('completed-date-warning');
    const input = $('fields').querySelector('[name="completedDate"]');
    if (!warning || !input) return;
    warning.textContent = isOldCompletedDate(input.value) ?
      '完成日が昨日より前（' + input.value + '）になっています。日付に間違いがないか確認してください。' : '';
  }

  function renderForm(selectedOrder = '') {
    const type = $('operation').value;
    const definition = workflow.interfaces[type];
    const order = state.orders.get(selectedOrder);
    const formFields = $('fields');
    formFields.replaceChildren();
    edited.clear();

    for (const field of definition.fields) {
      if (automaticField(type, field)) continue;
      const label = element('label');
      const input = inputFor(type, field, order);
      input.required = !['comment', 'confirmedDueDate', 'note'].includes(field) &&
        !(field === 'reason' && type === 'reply');
      if (field === 'orderId' && selectedOrder) input.value = selectedOrder;
      if (field === 'orderId') input.addEventListener('change', () => {
        const unsaved = hasUnsavedFinish(type);
        if (unsaved && !confirm('入力中の製造完了報告（完成日・良品部数・不足部数など）は、注文を切り替えると消えます。\n' +
          '注文を切り替えますか？')) {
          input.value = selectedOrder;
          show('注文の切り替えを取り消しました。入力内容はそのまま残っています。');
          return;
        }
        renderForm(input.value);
        if (unsaved) show('注文を切り替えました。製造完了報告の内容を入力し直してください。');
        formFields.querySelector('[name="orderId"]').focus();
      });
      label.append(element('span', fields[field][0] + (input.required ? ' *' : '')), input);
      if (field === 'instruction') widenable(label, input);
      if (field === 'completedDate') {
        const warning = element('span');
        warning.id = 'completed-date-warning';
        warning.className = 'field-warning';
        warning.setAttribute('role', 'status');
        label.append(warning);
        input.addEventListener('input', updateCompletedDateWarning);
      }
      formFields.append(label);
    }
    if (type === 'reply') {
      const detail = element('div');
      detail.id = 'request-detail';
      detail.setAttribute('aria-live', 'polite');
      formFields.append(detail);
      renderRequestDetail();
    }
    $('action-help').textContent = type === 'order' ? '注文IDと依頼IDは自動で発行します。' :
      definition.internal ? '製造部だけのメモです。台帳には残りますが、営業部へ渡すCSVは書き出しません。' :
      type === 'receipt' ? '読み込んだ依頼を選ぶと、正式な回答の前に「受信済み」を営業部へ知らせるCSVを書き出します。' +
        '「未回答の依頼」欄からまとめて書き出すこともできます。' :
      type === 'progress' ? '対象の注文を選択してください。完了済みで未完了の追加製造がない注文は表示されません。' :
      '対象の注文を選択してください。関連する依頼や校正は注文を選ぶと表示されます。';
    const button = $('save-event');
    button.textContent = actionLabels[type] || '登録してCSVを書き出す';
    button.title = definition.internal ? '台帳に記録します（CSVは書き出しません）' : '台帳に登録し、営業部へ渡すCSVを書き出します';
    button.disabled = type !== 'order' && orderChoices(type).length === 0;
    formSnapshot = enteredValues();
  }

  function captureInput() {
    const form = new FormData($('entry'));
    return {
      orderId: form.get('orderId') || '',
      values: [...edited].filter(name => name !== 'orderId').map(name => [name, form.get(name) || ''])
    };
  }

  // 引き継げなかった内容を利用者に知らせる文を返す。
  function restoreInput({ orderId, values }) {
    if (!orderId && !values.length) return '';
    if (orderId && !orderChoices($('operation').value).some(order => order.id === orderId)) {
      return '入力中だった注文（' + orderId + '）は対象外になったため、入力内容を引き継げませんでした。';
    }
    renderForm(orderId);
    const lost = [];
    for (const [name, value] of values) {
      const input = $('fields').querySelector('[name="' + name + '"]');
      if (!input) continue;
      input.value = value;
      if (input.value === value) {
        edited.add(name);
      } else {
        input.value = '';
        lost.push(fields[name][0]);
      }
    }
    renderRequestDetail();
    return '入力中の内容は引き継ぎました。' +
      (lost.length ? '次の項目は選べなくなったため選び直してください：' + lost.join('、') : '');
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function eventDownload(event) {
    download(event.type + '-' + event.orderId + '-' + event.eventId + '.csv',
      workflow.exportExchange(event.type, [event]));
  }

  function statusOf(order) {
    const request = state.requests.get(order.originalRequestId);
    if (order.cancelled) return 'キャンセル済み';
    if (!order.approved) return request.answer === '却下' ? '製造依頼却下' : '製造承認待ち';
    if (order.initialFinished) return order.goodQuantity < order.quantity ? '完了・不足あり' : '完了';
    return order.progress || '製造承認済み';
  }

  // 校正の状況（版番号は「校正版」の列に分けて出す, P-024）。
  function proofState(order) {
    return order.proofStatus ? order.proofStatus.replace(/（第\d+版）$/, '') : '—';
  }

  function rowMessage(tableBody, columns, message) {
    const row = element('tr');
    const cell = element('td', message);
    cell.colSpan = columns;
    cell.className = 'empty';
    row.append(cell);
    tableBody.append(row);
  }

  // 朝の段取りで先に拾う注文の判定。キャンセル済み・当初分完了の注文は対象外。
  function isOpen(order) {
    return !order.cancelled && !order.initialFinished;
  }

  function isDueToday(order, today) {
    return isOpen(order) && order.dueDate === today;
  }

  // 製造承認済みで、進捗通知をまだ出していない注文を「未着手」とする。
  function isNotStarted(order) {
    return isOpen(order) && order.approved && !order.progress;
  }

  // 校正確認依頼を出して、お客様（営業部経由）の校正回答を待っている注文。工程を進められない。
  function isProofWaiting(order) {
    return isOpen(order) && order.proofStatus.startsWith('回答待ち');
  }

  // 日付（YYYY-MM-DD）どうしの日数差。
  function daysBetween(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  }

  // 校正確認の回答期限を過ぎても返答がない注文（P-027）。一覧の先頭に出す。
  function isProofOverdue(order, today) {
    return isProofWaiting(order) && Boolean(order.proofDueDate) && order.proofDueDate < today;
  }

  // 校正の欄に出す文。返答待ちのときは何日待っているかと回答期限を添える。
  function proofText(order, today) {
    const state = proofState(order);
    if (!isProofWaiting(order)) return state;
    const waited = order.proofSentAt ? daysBetween(order.proofSentAt, today) : null;
    const days = waited === null ? '' : waited <= 0 ? ' 当日' : ' ' + waited + '日目';
    const due = order.proofDueDate ? '（期限 ' + order.proofDueDate +
      (order.proofDueDate < today ? '・' + daysBetween(order.proofDueDate, today) + '日超過' : '') + '）' : '';
    return state + days + due;
  }

  // 特急 → 今日納期 → 未着手 の順に上へ並べる。
  function priorityOf(order, today) {
    return (order.rush ? 0 : 4) + (isDueToday(order, today) ? 0 : 2) + (isNotStarted(order) ? 0 : 1);
  }

  // 作業一覧に出す注文。製造依頼を却下した注文（#79）と取消を承認した注文（#92）は外す。
  function isListed(order) {
    return !order.cancelled && state.requests.get(order.originalRequestId).answer !== '却下';
  }

  // 完了報告を出し終えた注文。当初分が完了し、回答待ち・承認済みで未完了の追加製造依頼が残っていないもの。
  function isDone(order) {
    return order.initialFinished && ![...state.requests.values()].some(request =>
      request.orderId === order.id && request.type === 'additional' &&
      (!request.answer || (request.answer === '承認' && !request.finished)));
  }

  // 毎朝の班長報告用。製造中（キャンセル・当初分完了を除く）の注文を最新の進捗の工程で数える。
  function renderStageCounts() {
    const holder = $('stage-counts');
    holder.replaceChildren();
    const open = [...state.orders.values()].filter(order => isOpen(order) && order.approved);
    for (const stage of workflow.stages) {
      const item = element('div');
      item.className = 'stage-count';
      const number = element('strong', formatCount(open.filter(order => order.progress === stage).length));
      item.append(element('span', stage), number, element('span', '件'));
      holder.append(item);
    }
  }

  // 用紙の選択肢を一覧にある用紙で作り直し、選択中の用紙を返す（一覧から消えた用紙は選択を外す）。
  function updatePaperChoices(input, orders) {
    const current = input.value;
    const counts = new Map();
    for (const order of orders) counts.set(order.paper, (counts.get(order.paper) || 0) + 1);
    const papers = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
    input.replaceChildren(option('', 'すべて'),
      ...papers.map(paper => option(paper, paper + '（' + counts.get(paper) + '件）')));
    input.value = papers.includes(current) ? current : '';
    return input.value;
  }

  // 注文詳細：工程が何度も更新された注文の経緯を、進捗通知の日時順に追えるようにする（P-028）。
  // 最新の状態だけでは分からない「いつ・どの工程に変わったか」を、完了見込み日の変化とあわせて並べる。
  function stageTimeline(order) {
    const steps = events.filter(event => event.orderId === order.id && event.type === 'progress')
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const finishes = events.filter(event => event.orderId === order.id && event.type === 'finish');
    if (!steps.length && !finishes.length) return null;
    const holder = element('details');
    holder.className = 'timeline no-print';
    holder.append(element('summary', '工程の経緯（' + (steps.length + finishes.length) + '件）'));
    const list = element('ol');
    let previous = '';
    for (const step of steps) {
      const item = element('li');
      const time = element('time', formatDateTime(step.updatedAt));
      time.dateTime = step.updatedAt;
      item.append(time, ' ', element('strong', step.stage),
        previous && previous !== step.stage ? '（' + previous + 'から）' : '',
        step.expectedDate ? ' 完了見込み ' + step.expectedDate : '');
      list.append(item);
      previous = step.stage;
    }
    for (const finish of finishes) {
      const item = element('li');
      item.className = 'finish';
      item.append(element('time', finish.completedDate), ' ', element('strong', '製造完了報告'),
        ' 良品 ' + copies(finish.goodQuantity) + (Number(finish.shortageQuantity) ? '・不足 ' + copies(finish.shortageQuantity) : ''));
      list.append(item);
    }
    holder.append(list);
    return holder;
  }

  // 担当者の選択肢（登録済みの担当者と「未割当」）を作り直し、選択中の値を返す（P-025）。
  function updateAssigneeChoices(input, orders) {
    const current = input.value;
    const counts = new Map();
    for (const order of orders) counts.set(order.assignee, (counts.get(order.assignee) || 0) + 1);
    const names = [...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
    const values = ['', ...names, ...(counts.has('') ? ['-'] : [])];
    input.replaceChildren(option('', 'すべて'),
      ...names.map(name => option(name, name + '（' + counts.get(name) + '件）')),
      ...(counts.has('') ? [option('-', '未割当（' + counts.get('') + '件）')] : []));
    input.value = values.includes(current) ? current : '';
    const list = $('assignee-names');
    list.replaceChildren(...[...new Set([...state.orders.values()].map(order => order.assignee).filter(Boolean))]
      .map(name => option(name, '')));
    return input.value;
  }

  function renderOrders() {
    const list = $('orders');
    list.replaceChildren();
    const today = localDate();
    const filter = $('order-filter');
    const wantDue = filter.elements.dueToday.checked;
    const wantNew = filter.elements.notStarted.checked;
    const wantRush = filter.elements.rush.checked;
    // バーコードを使わずに探せるよう、注文IDの一部（末尾数文字など）で部分一致させる。
    const idQuery = filter.elements.idSearch.value.trim().toLowerCase();
    // 完了報告済みの案件は通常の作業一覧から外し、「完了報告済みも表示」のときだけ出す。
    const listed = [...state.orders.values()].filter(isListed).reverse();
    const doneCount = listed.filter(isDone).length;
    const all = filter.elements.showDone.checked ? listed : listed.filter(order => !isDone(order));
    // 用紙ごとに段取りをまとめられるよう、一覧にある用紙から選んで絞り込む。
    const wantPaper = updatePaperChoices(filter.elements.paper, all);
    const wantAssignee = updateAssigneeChoices(filter.elements.assignee, all);
    // 今日納期・未着手は「どちらかに当てはまる」、特急はさらに特急だけに絞る。
    // 安定ソートなので、同じ優先度の中では新しい注文が上のまま。
    const shown = all
      .filter(order => !wantRush || order.rush)
      .filter(order => !filter.elements.proofWaiting.checked || isProofWaiting(order))
      .filter(order => !wantPaper || order.paper === wantPaper)
      .filter(order => !wantAssignee || order.assignee === (wantAssignee === '-' ? '' : wantAssignee))
      .filter(order => !idQuery || order.id.toLowerCase().includes(idQuery))
      .filter(order => (!wantDue && !wantNew) ||
        (wantDue && isDueToday(order, today)) || (wantNew && isNotStarted(order)));
    // 並び順（P-029）。初期表示は納期順。登録順は新しく登録した注文が上（all の並びのまま）。
    // 納期順・優先度順・品名順は、まず優先度順に並べてから並べ替える（安定ソートなので同じ納期・品名の中は優先度順）。
    const sortMode = filter.elements.sort.value;
    if (sortMode !== 'registered') {
      shown.sort((a, b) => priorityOf(a, today) - priorityOf(b, today));
      if (sortMode === 'due') shown.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      // 作業内容が同じ注文を固められるよう、品名順では品名でまとめる（P-014）。
      if (sortMode === 'product') shown.sort((a, b) => a.product.localeCompare(b.product, 'ja'));
      // 校正の回答期限が過ぎた注文は先頭に出す（P-027）。期限切れどうしは期限が古いものを上にする。
      shown.sort((a, b) => Number(isProofOverdue(b, today)) - Number(isProofOverdue(a, today)) ||
        (isProofOverdue(a, today) ? a.proofDueDate.localeCompare(b.proofDueDate) : 0));
    }

    const productCounts = new Map();
    for (const order of all) productCounts.set(order.product, (productCounts.get(order.product) || 0) + 1);

    for (const order of shown) {
      const row = element('tr');
      const dueToday = isDueToday(order, today);
      if (dueToday) row.className = 'due-today';
      if (isDone(order)) row.classList.add('done');
      const values = [order.id, order.product, order.paper, copies(order.quantity), order.dueDate,
        statusOf(order), proofText(order, today), order.proofVersion ? '第' + order.proofVersion + '版' : '—',
        order.expectedDate || '—',
        order.delayReason || '—', order.initialFinished || order.goodQuantity ? copies(order.goodQuantity) : '—'];
      const cells = values.map(value => element('td', value));
      productCell(cells[1], order, (productCounts.get(order.product) || 0) > 1);
      paperCell(cells[2], order);
      if (order.rush) row.classList.add('rush');
      const tags = [];
      if (order.rush) tags.push(['特急', 'tag tag-rush']);
      if (dueToday) tags.push(['今日納期', 'tag tag-due']);
      if (isNotStarted(order)) tags.push(['未着手', 'tag tag-new']);
      if (importedOrderIds.has(order.id)) tags.push(['今回新規', 'tag tag-imported']);
      if (isProofWaiting(order)) tags.push(['校正待ち', 'tag tag-proof']);
      if (isProofOverdue(order, today)) tags.push(['校正期限切れ', 'tag tag-due']);
      if (tags.length) {
        const holder = element('div');
        for (const [label, className] of tags) {
          const tag = element('span', label);
          tag.className = className;
          holder.append(tag);
        }
        cells[0].prepend(holder);
      }
      const assignee = element('div', '担当：' + (order.assignee || '未割当'));
      assignee.className = 'sub assignee' + (order.assignee ? '' : ' unassigned');
      cells[0].append(assignee);
      const timeline = stageTimeline(order);
      if (timeline) cells[0].append(timeline);
      row.append(...cells);
      list.append(row);
    }
    if (!list.children.length) {
      rowMessage(list, 11, all.length ? '条件に合う注文はありません。' : '注文がありません。');
    }
    $('order-count').textContent = shown.length === all.length ?
      all.length + '件' : shown.length + '件 ／ 全' + all.length + '件';
    $('due-today-count').textContent = '（' + all.filter(order => isDueToday(order, today)).length + '件）';
    $('not-started-count').textContent = '（' + all.filter(isNotStarted).length + '件）';
    $('rush-count').textContent = '（' + all.filter(order => order.rush).length + '件）';
    $('done-count').textContent = '（' + doneCount + '件）';
    $('proof-waiting-count').textContent = '（' + all.filter(isProofWaiting).length + '件）';
  }

  function renderRejected() {
    const list = $('rejected');
    list.replaceChildren();
    const rejected = [...state.requests.values()].filter(request => request.answer === '却下').reverse();
    for (const request of rejected) {
      const order = state.orders.get(request.orderId);
      const content = ['paper', 'quantity', 'dueDate', 'reason'].filter(field => request[field])
        .map(field => fields[field][0] + '：' + (field === 'quantity' ? copies(request[field]) : request[field]))
        .join('\n');
      const values = [order.id, order.product, workflow.interfaces[request.type].name, request.requestId,
        content, request.answerReason];
      const row = element('tr');
      row.append(...values.map(value => element('td', value || '—')));
      row.cells[4].className = 'multiline';
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 6, '却下した依頼はありません。');
    $('rejected-count').textContent = rejected.length + '件';
  }

  function renderCancelled() {
    const list = $('cancelled');
    list.replaceChildren();
    const approved = [...state.requests.values()]
      .filter(request => request.type === 'cancel' && request.answer === '承認').reverse();
    const keyword = $('cancel-search').value.trim().toLowerCase();
    const matched = approved.map(request => {
      const order = state.orders.get(request.orderId);
      return [order.id, order.product, order.paper, copies(order.quantity), request.requestId,
        request.reason, request.answerReason];
    }).filter(values => [values[0], values[1], values[4]].some(value => value.toLowerCase().includes(keyword)));
    for (const values of matched) {
      const row = element('tr');
      row.append(...values.map(value => element('td', value || '—')));
      list.append(row);
    }
    if (!list.children.length) {
      rowMessage(list, 7, approved.length ? '該当する記録がありません。' : '取消を承認した注文はありません。');
    }
    $('cancelled-count').textContent = approved.length + '件';
  }

  // 承認・却下をまだ出していない依頼だけの一覧。届いた順（古い依頼が上）に並べる。
  function requestSummary(request) {
    const parts = [];
    if (request.paper && request.type !== 'order') parts.push('用紙 ' + request.paper);
    if (request.quantity) parts.push(copies(request.quantity));
    if (request.dueDate) parts.push('希望納期 ' + request.dueDate);
    if (request.reason) parts.push('理由：' + request.reason);
    return parts.join(' ／ ') || '—';
  }

  function startReply(request) {
    if (hasUnsavedFinish($('operation').value) &&
      !confirm('入力中の製造完了報告は消えます。依頼回答に切り替えますか？')) return;
    $('operation').value = 'reply';
    renderForm(request.orderId);
    const requestInput = $('fields').querySelector('[name="requestId"]');
    requestInput.value = request.requestId;
    renderRequestDetail();
    $('entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
    ($('fields').querySelector('[name="decision"]') || requestInput).focus({ preventScroll: true });
    show(workflow.interfaces[request.type].name + '（' + request.requestId + '）への回答を入力してください。');
  }

  function renderPending() {
    const list = $('pending');
    list.replaceChildren();
    const pending = [...state.requests.values()].filter(request => !request.answer);
    for (const request of pending) {
      const order = state.orders.get(request.orderId);
      const row = element('tr');
      const typeCell = element('td', workflow.interfaces[request.type].name);
      if (request.type === 'order' && order.rush) {
        const tag = element('span', '特急');
        tag.className = 'tag tag-rush';
        typeCell.prepend(tag);
        row.classList.add('rush');
      }
      const orderCell = element('td');
      productCell(orderCell, order, false);
      const button = element('button', '回答する');
      button.type = 'button';
      button.addEventListener('click', () => startReply(request));
      const actionCell = element('td');
      actionCell.append(button);
      const receiptCell = element('td');
      if (request.receivedAt) {
        receiptCell.textContent = '通知済み ' + formatDateTime(request.receivedAt);
      } else {
        const notify = element('button', '受信を通知');
        notify.type = 'button';
        notify.className = 'secondary';
        notify.addEventListener('click', () => sendReceipts([request]));
        receiptCell.append(notify);
      }
      row.append(typeCell, orderCell, element('td', requestSummary(request)), element('td', request.requestId),
        receiptCell, actionCell);
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 6, '未回答の依頼はありません。');
    $('pending-count').textContent = pending.length + '件';
    const unnotified = pending.filter(request => !request.receivedAt).length;
    $('notify-all').disabled = !unnotified;
    $('notify-all').textContent = unnotified ? '未通知の ' + unnotified + ' 件をまとめて受信通知' : '受信通知はすべて送信済み';
  }

  function formatDateTime(iso) {
    const date = new Date(iso);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + ' ' + String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');
  }

  // 正式な回答の前に「受信済み」を営業部へ知らせる。複数件はまとめて1つのCSVに書き出す。
  function sendReceipts(requests) {
    const receivedAt = new Date().toISOString();
    const items = requests.map(request => ({ eventId: identifier('EV'), type: 'receipt',
      requestId: request.requestId, orderId: request.orderId, receivedAt, createdAt: localDate() }));
    try {
      events = workflow.mergeEvents(events, items).events;
      const draft = captureInput();
      refresh();
      restoreInput(draft);
      download('receipt-' + (items.length === 1 ? items[0].orderId + '-' + items[0].eventId : localDate() + '-' + items.length + '件') + '.csv',
        workflow.exportExchange('receipt', items));
      show('受信通知を ' + items.length + ' 件書き出しました。営業部へ渡してください。');
    } catch (error) {
      show(error.message, true);
    }
  }

  // 日付（YYYY-MM-DD）から days 日前の日付を返す。
  function daysBefore(date, days) {
    const day = new Date(date + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() - days);
    return day.toISOString().slice(0, 10);
  }

  function renderHistory() {
    const list = $('history');
    list.replaceChildren();
    // 取り込み日（importedAt）は台帳にだけ残す記録。相手部署へ書き出すCSVには含めない。
    const since = $('history-filter').elements.since.value;
    const shown = [...events].reverse().filter(event => !since || (event.importedAt && event.importedAt >= since));
    for (const event of shown) {
      const definition = workflow.interfaces[event.type];
      const sent = definition.from === department;
      const row = element('tr');
      const detail = element('details');
      detail.append(element('summary', '内容を見る'));
      const metadata = element('dl');
      for (const field of definition.fields) {
        metadata.append(element('dt', fields[field]?.[0] || '更新日時'), element('dd',
          (quantityFields.includes(field) ? formatCount(event[field]) : event[field]) || '—'));
      }
      detail.append(metadata);
      const detailCell = element('td');
      detailCell.append(detail);
      const actionCell = element('td');
      if (sent && !definition.internal) {
        const button = element('button', 'CSVを書き出す');
        button.type = 'button';
        button.className = 'secondary';
        button.addEventListener('click', () => eventDownload(event));
        actionCell.append(button);
      } else {
        actionCell.textContent = '—';
      }
      row.append(element('td', definition.internal ? '部内メモ' : sent ? '送信側' : '受信側'), element('td', definition.name),
        element('td', event.orderId), element('td', event.importedAt || '—'), detailCell, actionCell);
      list.append(row);
    }
    if (!list.children.length) {
      rowMessage(list, 6, events.length ? since + ' 以降に取り込んだやり取りはありません。' : 'やり取りはまだありません。');
    }
    $('history-count').textContent = shown.length === events.length ?
      events.length + '件' : shown.length + '件 ／ 全' + events.length + '件';
  }

  function refresh() {
    state = workflow.buildState(events);
    renderStageCounts();
    renderPending();
    renderOrders();
    renderRejected();
    renderHistory();
    renderCancelled();
    renderForm();
  }

  $('cancel-search').addEventListener('input', renderCancelled);
  $('notify-all').addEventListener('click', () =>
    sendReceipts([...state.requests.values()].filter(request => !request.answer && !request.receivedAt)));
  $('history-filter').addEventListener('change', renderHistory);
  $('history-filter').addEventListener('click', event => {
    const button = event.target.closest('button[data-since]');
    if (!button) return;
    $('history-filter').elements.since.value = button.dataset.since === '' ? '' :
      daysBefore(localDate(), Number(button.dataset.since));
    renderHistory();
  });

  $('operation').append(...outgoing.map(([type, definition]) => option(type, definition.name)));
  $('operation').addEventListener('change', () => renderForm());
  $('order-filter').addEventListener('change', renderOrders);
  $('order-filter').addEventListener('input', renderOrders);
  $('fields').addEventListener('input', event => edited.add(event.target.name));
  $('fields').addEventListener('change', event => {
    if (event.target.name === 'requestId') renderRequestDetail();
  });

  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    const type = $('operation').value;
    const data = Object.fromEntries(new FormData($('entry')));
    if (type === 'finish' && isOldCompletedDate(data.completedDate) &&
      !confirm('完成日が ' + data.completedDate + ' になっています（昨日より前の日付です）。\n' +
        'このまま製造完了報告を送りますか？')) {
      show('製造完了報告の送信を取りやめました。完成日を確認してください。');
      $('fields').querySelector('[name="completedDate"]').focus();
      return;
    }
    const item = { eventId: identifier('EV'), type, ...data };
    if (type === 'order') item.orderId = identifier('ORD');
    if (['order', 'change', 'cancel', 'additional'].includes(type)) item.requestId = identifier('REQ');
    if (type === 'proof') item.proofId = identifier('PRF');
    if (type === 'progress') item.updatedAt = new Date().toISOString();
    if (type === 'receipt') item.receivedAt = new Date().toISOString();
    // 登録した日（台帳だけの記録）。校正確認の返答待ち日数などに使う（P-027）。
    item.createdAt = localDate();

    try {
      events = workflow.mergeEvents(events, [item]).events;
      refresh();
      // 製造部内メモは台帳に残すだけで、営業部へ渡すCSVは書き出さない。
      if (workflow.interfaces[type].internal) {
        show(workflow.interfaces[type].name + 'を残しました。営業部へのCSVは書き出していません。台帳の保存を忘れずに行ってください。');
        return;
      }
      eventDownload(item);
      show(workflow.interfaces[type].name + 'を登録し、CSVを書き出しました。');
    } catch (error) {
      show(error.message, true);
    }
  });

  $('incoming').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      const text = await file.text();
      const importedAt = localDate();
      const incoming = workflow.readExchange(text, department).map(item => ({ ...item, importedAt }));
      const result = workflow.mergeEvents(events, incoming);
      const draft = captureInput();
      const knownOrders = new Set(state.orders.keys());
      events = result.events;
      refresh();
      showImportedOrders(file.name, [...state.orders.values()].filter(order => !knownOrders.has(order.id)), result.skipped);
      const notice = restoreInput(draft);
      const unnotified = [...state.requests.values()].filter(request => !request.answer && !request.receivedAt).length;
      show(file.name + ' を取り込みました。新規 ' + result.accepted + ' 件、取り込み済み ' + result.skipped + ' 件。' + notice +
        (unnotified ? '受信通知をまだ出していない依頼が ' + unnotified + ' 件あります（「未回答の依頼」欄から書き出せます）。' : ''));
    } catch (error) {
      show('取り込みを中止しました。' + error.message, true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  });

  // 複数件の製造依頼CSVを取り込んだあと、どの注文が新規だったかを一覧で見せる。
  // 注文一覧でも「今回新規」の目印を付ける（次の取り込みか「閉じる」まで）。
  function showImportedOrders(fileName, orders, skipped) {
    const panel = $('import-result');
    const list = $('import-result-list');
    list.replaceChildren();
    importedOrderIds = new Set(orders.map(order => order.id));
    panel.hidden = !orders.length;
    if (!orders.length) {
      renderOrders();
      return;
    }
    for (const order of orders) {
      const row = element('tr');
      row.append(...[order.id, order.product, order.paper, copies(order.quantity), order.dueDate,
        order.rush ? '特急' : '通常'].map(value => element('td', value)));
      if (order.rush) row.classList.add('rush');
      list.append(row);
    }
    $('import-result-count').textContent = orders.length + '件';
    $('import-result-note').textContent = fileName + ' で新しく登録された注文です。' +
      (skipped ? '取り込み済みだった ' + skipped + ' 件は含みません。' : '') +
      '注文一覧では「今回新規」の目印が付きます。';
    renderOrders();
  }

  $('close-import-result').addEventListener('click', () => {
    $('import-result').hidden = true;
    importedOrderIds = new Set();
    renderOrders();
  });

  // 会議用の印刷。今の絞り込みのまま注文一覧だけを印刷し、何で絞った一覧かを上に書いておく。
  function printConditions() {
    const filter = $('order-filter');
    const conditions = [['dueToday', '今日納期'], ['notStarted', '未着手'], ['rush', '特急だけ'],
      ['proofWaiting', '校正待ちだけ'],
      ['showDone', '完了報告済みも表示']]
      .filter(([name]) => filter.elements[name].checked).map(([, label]) => label);
    if (filter.elements.paper.value) conditions.push('用紙「' + filter.elements.paper.value + '」');
    const assignee = filter.elements.assignee.value;
    if (assignee) conditions.push(assignee === '-' ? '担当者 未割当' : '担当者「' + assignee + '」');
    const idQuery = filter.elements.idSearch.value.trim();
    if (idQuery) conditions.push('注文IDに「' + idQuery + '」を含む');
    return (conditions.length ? conditions.join('・') : 'なし（全件）') +
      '　並び順：' + filter.elements.sort.selectedOptions[0].textContent;
  }

  function updatePrintInfo() {
    const now = new Date();
    $('print-info').textContent = '印刷日時：' + localDate() + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') +
      '　絞り込み：' + printConditions() + '　表示件数：' + $('order-count').textContent;
  }

  window.addEventListener('beforeprint', updatePrintInfo);
  $('print-orders').addEventListener('click', () => {
    updatePrintInfo();
    window.print();
  });

  $('save-backup').addEventListener('click', () => {
    download(department + '-backup-' + localDate() + '.csv', workflow.exportBackup(department, events));
    show('台帳を保存しました。再開時は「台帳を開く」を使ってください。');
  });

  $('backup').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    try {
      const saved = workflow.readBackup(department, await file.text());
      if (events.length && !confirm('現在の台帳を置き換えますか？')) return;
      events = saved;
      refresh();
      show('保存済みの台帳を開きました。');
    } catch (error) {
      show('台帳を開けませんでした。' + error.message, true);
    } finally {
      input.value = '';
    }
  });

  const guidance = $('csv-types');
  for (const [type, definition] of Object.entries(workflow.interfaces)) {
    const item = element('li', (definition.internal ? '部内のみ（CSVなし）' :
      definition.from === department ? '書き出し' : '取り込み') + ' · ' +
      definition.name + '（' + type + '）');
    guidance.append(item);
  }
  refresh();
})();