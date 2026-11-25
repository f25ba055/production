(function () {
  'use strict';

  // 両部署の取り込み・書き出しで共通のCSV仕様。
  const interfaces = {
    order:       { name: '製造依頼', from: 'sales', fields: 'requestId orderId product paper quantity dueDate rush channel receiveMethod' },
    change:      { name: '注文変更依頼', from: 'sales', fields: 'requestId orderId paper quantity dueDate reason' },
    cancel:      { name: 'キャンセル依頼', from: 'sales', fields: 'requestId orderId reason' },
    proofReply:  { name: '校正回答', from: 'sales', fields: 'orderId proofId proofDecision comment confirmedFile' },
    additional:  { name: '追加製造依頼', from: 'sales', fields: 'requestId orderId quantity dueDate reason' },
    // 分納（P-026）。製造依頼・追加製造依頼を、回（deliveryNo）ごとの納品日と部数に分ける。1回につき1行。
    split:       { name: '分納指示', from: 'sales', fields: 'orderId requestId deliveryNo deliveryDate quantity' },
    reply:       { name: '依頼回答', from: 'factory', fields: 'requestId orderId decision confirmedDueDate reason reasonCode printedQuantity extraCost' },
    // 依頼を読み込んだことを、正式な回答（依頼回答）の前に営業部へ知らせる（P-006）。
    receipt:     { name: '受信通知', from: 'factory', fields: 'requestId orderId receivedAt' },
    proof:       { name: '校正確認依頼', from: 'factory', fields: 'orderId proofId version instruction responseDueDate proofFile' },
    progress:    { name: '製造進捗通知', from: 'factory', fields: 'orderId stage updatedAt expectedDate' },
    delay:       { name: '納期遅延通知', from: 'factory', fields: 'orderId reason expectedDate' },
    // 訂正版（P-038）は correctsEventId に元の報告のイベントIDを入れる。元の報告の部数を置き換える（足さない）。
    finish:      { name: '製造完了報告', from: 'factory', fields: 'orderId requestId completedDate goodQuantity shortageQuantity deliveryNo correctsEventId spareQuantity' },
    // 製造部だけの記録（internal）。台帳には残すが、相手部署とはCSVでやり取りしない。
    paperMemo:   { name: '用紙メモ（製造部内）', from: 'factory', internal: true, fields: 'orderId paperStatus memoDate note' },
    assign:      { name: '担当者の割り当て（製造部内）', from: 'factory', internal: true, fields: 'orderId assignee' },
    // 班の交代時の申し送り（P-044）。営業部には送らない。
    handover:    { name: '申し送り（製造部内）', from: 'factory', internal: true, fields: 'orderId handoverNote' }
  };
  for (const definition of Object.values(interfaces)) {
    definition.fields = definition.fields.split(' ');
  }

  // 列を追加する前の形式。旧形式のCSV・台帳も読めるよう、足りない列は既定値で補う。
  // 受付経路（channel, P-011）の列がない旧形式は「未設定」として読む。
  // 却下理由の分類（reasonCode, P-022）の列がない旧形式の依頼回答は、分類なし（空）として読む。
  // 分納の回（deliveryNo, P-026）の列がない旧形式の製造完了報告は、分納なし（空）として読む。
  // 校正PDFのファイル名（proofFile / confirmedFile, P-031）の列がない旧形式は、ファイル名なし（空）として読む。
  // 列は必ず末尾に足していくので、旧形式の見出しは今の見出しの先頭部分と一致する。
  // 足りない末尾の列がすべて既定値を持っていれば、旧形式として受け付ける。
  const fieldDefaults = { rush: '通常', channel: '未設定', reasonCode: '', deliveryNo: '', proofFile: '', confirmedFile: '',
    correctsEventId: '', receiveMethod: '未設定', printedQuantity: '', extraCost: '',
    spareQuantity: '' };

  function isLegacyHeader(header, expected) {
    return header.length < expected.length && header.length > 2 &&
      header.every((field, index) => field === expected[index]) &&
      expected.slice(header.length).every(field => Object.hasOwn(fieldDefaults, field));
  }
  const reasonCodes = ['資材不足', '希望納期不可', '設備都合', '仕様不可', 'その他'];
  const rushValues = ['通常', '特急'];
  const channelValues = ['店頭', '電話', 'メール', '未設定'];
  // 受取方法（P-042）。営業部が指定する。列がない旧形式は「未設定」。
  const receiveMethods = ['店頭受取', '配送', '未設定'];

  function withDefaults(event) {
    const filled = { ...event };
    if (Object.hasOwn(interfaces, event.type)) {
      for (const field of interfaces[event.type].fields) {
        if (filled[field] === undefined && Object.hasOwn(fieldDefaults, field)) filled[field] = fieldDefaults[field];
      }
    }
    return filled;
  }

  const stages = ['準備中', '印刷中', '加工中', '検品中'];
  const requestTypes = ['order', 'change', 'cancel', 'additional'];
  const optionalFields = ['comment', 'confirmedDueDate', 'reason', 'note', 'reasonCode', 'deliveryNo', 'proofFile',
    'confirmedFile', 'correctsEventId', 'printedQuantity', 'extraCost', 'spareQuantity'];
  const paperStatuses = ['仮手配', '入庫'];
  const positiveFields = ['quantity', 'version'];
  const countFields = ['goodQuantity', 'shortageQuantity'];
  const dateFields = ['dueDate', 'confirmedDueDate', 'responseDueDate', 'expectedDate', 'completedDate', 'memoDate',
    'deliveryDate'];

  function isProofFileName(name) {
    return name.length <= 100 && /\.pdf$/i.test(name) && !/[\\/:*?"<>|]/.test(name) && name.trim() === name;
  }

  function requireThat(condition, message) {
    if (!condition) throw new Error(message);
  }

  function validateEvent(event) {
    const definition = Object.hasOwn(interfaces, event.type) && interfaces[event.type];
    requireThat(definition, 'CSVの種類が不明です。');
    requireThat(/^[A-Za-z0-9_-]+$/.test(event.eventId), 'イベントIDが不正です。');

    for (const field of definition.fields) {
      const value = event[field];
      requireThat(typeof value === 'string', field + ' がありません。');
      if (!optionalFields.includes(field)) {
        requireThat(value.trim(), field + ' は必須です。');
      }
      if (positiveFields.includes(field) || countFields.includes(field)) {
        requireThat(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), field + ' は整数で入力してください。');
        requireThat(countFields.includes(field) || Number(value) > 0, field + ' は1以上で入力してください。');
      }
      if (dateFields.includes(field) && value) {
        const date = new Date(value + 'T00:00:00Z');
        requireThat(/^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(date) &&
          date.toISOString().slice(0, 10) === value, field + ' は有効な日付で入力してください。');
      }
      if (field.endsWith('Id') && (value || !optionalFields.includes(field))) {
        requireThat(/^[A-Za-z0-9_-]+$/.test(value), field + ' が不正です。');
      }
    }
    requireThat(event.type === 'reply' || event.type === 'order' ||
      !definition.fields.includes('reason') || event.reason.trim(), '理由を入力してください。');
    if (event.type === 'reply') {
      requireThat(['承認', '却下'].includes(event.decision), '依頼回答が不正です。');
      // 却下は分類（reasonCode）か理由のどちらかが必要。旧形式の却下は理由だけが入っている。
      requireThat(event.decision !== '却下' || event.reasonCode || event.reason.trim(), '却下理由を選んでください。');
      requireThat(event.reasonCode === '' || (event.decision === '却下' && reasonCodes.includes(event.reasonCode)),
        '却下理由の分類が不正です。');
      requireThat(event.reasonCode !== 'その他' || event.reason.trim(), '却下理由が「その他」のときは、理由（補足）を入力してください。');
      // キャンセル依頼への回答（P-046）だけ、印刷済み部数と追加費用の見込み（円）を付けられる。空欄は「なし・不明」。
      for (const field of ['printedQuantity', 'extraCost']) {
        requireThat(event[field] === '' || (/^\d+$/.test(event[field]) && Number.isSafeInteger(Number(event[field]))),
          (field === 'printedQuantity' ? '印刷済み部数' : '追加費用の見込み') + 'は0以上の整数で入力してください。');
      }
    }
    if (event.type === 'order') {
      requireThat(rushValues.includes(event.rush), '特急区分は「通常」か「特急」で入力してください。');
      requireThat(channelValues.includes(event.channel), '受付経路は「店頭」「電話」「メール」のいずれかで入力してください。');
      requireThat(receiveMethods.includes(event.receiveMethod), '受取方法は「店頭受取」か「配送」で入力してください。');
    }
    if (event.type === 'proofReply') {
      requireThat(['承認', '修正依頼'].includes(event.proofDecision), '校正回答が不正です。');
      requireThat(event.proofDecision !== '修正依頼' || event.comment.trim(), '修正内容を入力してください。');
    }
    if (event.type === 'split' || (event.type === 'finish' && event.deliveryNo)) {
      requireThat(/^\d+$/.test(event.deliveryNo) && Number(event.deliveryNo) >= 1 && Number(event.deliveryNo) <= 99,
        '分納の回は1〜99の整数で入力してください。');
    }
    for (const field of ['proofFile', 'confirmedFile']) {
      if (event[field]) {
        requireThat(isProofFileName(event[field]),
          '校正PDFのファイル名が不正です（「.pdf」で終わる100文字以内の名前にし、\\ / : * ? " < > | は使えません）。');
      }
    }
    // 予備部数（P-051）。注文どおりの良品数とは別に営業部へ渡す余分の部数。良品＋不足の合計には含めない。
    if (event.type === 'finish') {
      requireThat(event.spareQuantity === '' || (/^\d+$/.test(event.spareQuantity) && Number.isSafeInteger(Number(event.spareQuantity))),
        '予備部数は0以上の整数で入力してください。');
    }
    if (event.type === 'handover') {
      requireThat(event.handoverNote.length <= 500, '申し送りは500文字以内で入力してください。');
    }
    if (event.type === 'assign') {
      requireThat(event.assignee.trim().length <= 30, '担当者名は30文字以内で入力してください。');
    }
    if (event.type === 'paperMemo') {
      requireThat(paperStatuses.includes(event.paperStatus), '用紙の状況は「仮手配」か「入庫」で入力してください。');
    }
    if (event.type === 'receipt') {
      requireThat(/^\d{4}-\d{2}-\d{2}T/.test(event.receivedAt) &&
        !isNaN(Date.parse(event.receivedAt)), '受信日時が不正です。');
    }
    if (event.type === 'progress') {
      requireThat(stages.includes(event.stage), '工程が不正です。');
      requireThat(/^\d{4}-\d{2}-\d{2}T/.test(event.updatedAt) &&
        !isNaN(Date.parse(event.updatedAt)), '更新日時が不正です。');
    }
  }

  function availableOrder(order) {
    return order && order.approved && !order.cancelled;
  }

  function applyEvent(state, event) {
    validateEvent(event);
    const order = state.orders.get(event.orderId);
    const request = state.requests.get(event.requestId);
    const proof = state.proofs.get(event.proofId);

    if (event.type === 'order') {
      requireThat(!order && !request, '注文IDまたは依頼IDが重複しています。');
      state.orders.set(event.orderId, {
        id: event.orderId, originalRequestId: event.requestId, product: event.product,
        paper: event.paper, quantity: Number(event.quantity), dueDate: event.dueDate, rush: event.rush === '特急',
        channel: event.channel || '未設定', receiveMethod: event.receiveMethod || '未設定',
        approved: false, cancelled: false, progress: '', progressAt: '',
        expectedDate: '', delayReason: '', goodQuantity: 0, initialFinished: false, proofStatus: '', proofVersion: 0, proofComment: '', proofSentAt: '', proofDueDate: '', paperMemos: [], assignee: '', handovers: []
      });
    } else {
      requireThat(order, '該当する注文がありません。先行するCSVを読み込んでください。');
    }

    if (requestTypes.includes(event.type)) {
      requireThat(!request, '依頼IDが重複しています。');
      if (event.type !== 'order') {
        requireThat(availableOrder(order), '承認済みで有効な注文を選んでください。');
      }
      state.requests.set(event.requestId, { ...event, answer: '', finished: false, targetQuantity: Number(event.quantity || 0) });
      return;
    }

    if (event.type === 'receipt') {
      requireThat(request && request.orderId === order.id, '該当する依頼がありません。');
      requireThat(!request.receivedAt, 'この依頼の受信通知はすでに出しています。');
      request.receivedAt = event.receivedAt;
      return;
    }

    if (event.type === 'reply') {
      requireThat(request && request.orderId === order.id && !request.answer, '該当する未回答の依頼がありません。');
      const approved = event.decision === '承認';
      if (approved && request.type !== 'order') {
        requireThat(availableOrder(order), 'キャンセル済みの注文は承認できません。');
      }
      if (approved && request.type === 'change') {
        requireThat(!order.initialFinished, '当初分の製造完了後は注文変更を承認できません。');
        order.paper = request.paper;
        order.quantity = Number(request.quantity);
        state.requests.get(order.originalRequestId).targetQuantity = order.quantity;
        // 今の正式な条件を決めた注文変更依頼（P-049）。
        order.conditionRequestId = request.requestId;
      }
      if (approved && request.type === 'cancel') {
        requireThat(!order.initialFinished, '当初分の製造完了後はキャンセルを承認できません。');
        order.cancelled = true;
      }
      if (approved && request.type === 'order') order.approved = true;
      if (approved && ['order', 'change'].includes(request.type)) {
        order.dueDate = event.confirmedDueDate || request.dueDate;
      }
      request.answer = event.decision;
      request.confirmedDueDate = event.confirmedDueDate || request.dueDate || '';
      request.answerReason = event.reason;
      request.answerReasonCode = event.reasonCode || '';
      if (event.printedQuantity !== '' || event.extraCost !== '') {
        requireThat(request.type === 'cancel', '印刷済み部数・追加費用の見込みは、キャンセル依頼への回答にだけ付けられます。');
      }
      request.printedQuantity = event.printedQuantity;
      request.extraCost = event.extraCost;
      return;
    }

    // 用紙の仮手配は製造承認の前に行うこともあるため、キャンセル済みでなければ記録できる。
    // 分納指示（P-026）。製造承認の前に届くこともあるため、キャンセル済みでなければ受け付ける。
    if (event.type === 'split') {
      requireThat(!order.cancelled, 'キャンセル済みの注文は分納にできません。');
      requireThat(request && request.orderId === order.id && ['order', 'additional'].includes(request.type) &&
        request.answer !== '却下' && !request.finished, '分納にする製造依頼（未完了）が見つかりません。');
      const deliveries = request.deliveries || (request.deliveries = []);
      const no = Number(event.deliveryNo);
      requireThat(!deliveries.some(delivery => delivery.no === no), '第' + no + '回の分納指示はすでにあります。');
      const planned = deliveries.reduce((sum, delivery) => sum + delivery.quantity, 0) + Number(event.quantity);
      requireThat(planned <= request.targetQuantity,
        '分納の部数の合計（' + planned + '部）が依頼の部数（' + request.targetQuantity + '部）を超えています。');
      deliveries.push({ no, date: event.deliveryDate, quantity: Number(event.quantity), finished: false,
        goodQuantity: 0, shortageQuantity: 0, completedDate: '' });
      deliveries.sort((a, b) => a.no - b.no);
      return;
    }

    if (event.type === 'handover') {
      requireThat(!order.cancelled, 'キャンセル済みの注文には申し送りを残せません。');
      order.handovers.push({ note: event.handoverNote, date: event.createdAt || '', by: event.registeredBy || '' });
      return;
    }

    // 班長が各注文に担当者を振る（P-025）。最後に登録した担当者を今の担当とする。
    if (event.type === 'assign') {
      requireThat(!order.cancelled, 'キャンセル済みの注文には担当者を登録できません。');
      order.assignee = event.assignee.trim();
      return;
    }

    if (event.type === 'paperMemo') {
      requireThat(!order.cancelled, 'キャンセル済みの注文にはメモを残せません。');
      order.paperMemos.push({ status: event.paperStatus, date: event.memoDate, note: event.note });
      return;
    }

    requireThat(availableOrder(order), '承認済みで有効な注文を選んでください。');
    switch (event.type) {
      case 'proof': {
        requireThat(!proof, '校正IDが重複しています。');
        const previous = [...state.proofs.values()].filter(item => item.orderId === order.id).at(-1);
        requireThat(!previous || (['修正依頼', '要再確認'].includes(previous.answer) &&
          Number(event.version) > Number(previous.version)),
          '前の校正に修正依頼があり、版番号が上がっていることを確認してください。');
        state.proofs.set(event.proofId, { ...event, answer: '' });
        order.proofStatus = '回答待ち（第' + event.version + '版）';
        order.proofVersion = Number(event.version);
        order.proofComment = '';
        // 返答待ち日数の起点。createdAt は製造部の台帳にだけ残す記録（CSVには含めない）。
        order.proofSentAt = event.createdAt || '';
        order.proofDueDate = event.responseDueDate;
        order.proofFile = event.proofFile || '';
        break;
      }
      case 'proofReply':
        requireThat(proof && proof.orderId === order.id && !proof.answer, '該当する回答待ちの校正がありません。');
        proof.answer = event.proofDecision;
        proof.comment = event.comment;
        order.proofStatus = event.proofDecision + '（第' + proof.version + '版）';
        // 修正依頼の理由（複数行のこともある, P-039）。次の版を送るまで一覧に出す。
        order.proofComment = event.proofDecision === '修正依頼' ? event.comment : '';
        // 版の取り違え防止（P-031）。営業部が確認したファイル名が送ったファイル名と違えば、承認として扱わず要再確認にする。
        if (event.confirmedFile && proof.proofFile && event.confirmedFile !== proof.proofFile) {
          proof.answer = '要再確認';
          order.proofStatus = '要再確認（ファイル名不一致・第' + proof.version + '版）';
          order.proofComment = 'お客様が確認したファイル名「' + event.confirmedFile + '」が、送ったファイル名「' +
            proof.proofFile + '」と違います。版を確かめて、校正確認依頼を送り直してください。';
        }
        break;
      case 'progress':
        if (!order.progressAt || Date.parse(event.updatedAt) >= Date.parse(order.progressAt)) {
          order.progressAt = event.updatedAt;
          order.progress = event.stage;
          order.expectedDate = event.expectedDate;
        }
        break;
      case 'delay':
        order.delayReason = event.reason;
        order.expectedDate = event.expectedDate;
        break;
      case 'finish': {
        const reported = Number(event.goodQuantity) + Number(event.shortageQuantity);
        const copies = value => Number(value).toLocaleString('ja-JP') + '部';
        if (event.correctsEventId) {
          correctFinish(state, event, order, request, reported, copies);
          break;
        }
        requireThat(request && request.orderId === order.id && ['order', 'additional'].includes(request.type) &&
          request.answer === '承認' && !request.finished, '承認済みで未完了の製造依頼を選んでください。');
        requireThat(!order.proofStatus || order.proofStatus.startsWith('承認'), '校正の承認を確認してください。');
        if (request.deliveries && request.deliveries.length) {
          // 分納（P-026）は回ごとに完了報告を受け、すべての回がそろったら依頼を完了にする。
          requireThat(event.deliveryNo, 'この依頼は分納です。完了した回を選んでください。');
          const delivery = request.deliveries.find(item => item.no === Number(event.deliveryNo));
          requireThat(delivery && !delivery.finished, '未完了の分納の回を選んでください。');
          requireThat(reported === delivery.quantity,
            '良品部数と不足部数の合計を、この回（第' + delivery.no + '回）の部数に合わせてください。予定部数は' +
            copies(delivery.quantity) + '、入力の合計は' + copies(reported) + '（良品' + copies(event.goodQuantity) +
            '＋不足' + copies(event.shortageQuantity) + '）です。');
          delivery.finished = true;
          delivery.goodQuantity = Number(event.goodQuantity);
          delivery.shortageQuantity = Number(event.shortageQuantity);
          delivery.completedDate = event.completedDate;
          recordFinish(state, event);
          request.goodQuantity = (request.goodQuantity || 0) + delivery.goodQuantity;
          request.shortageQuantity = (request.shortageQuantity || 0) + delivery.shortageQuantity;
          order.goodQuantity += delivery.goodQuantity;
          const planned = request.deliveries.reduce((sum, item) => sum + item.quantity, 0);
          if (request.deliveries.every(item => item.finished) && planned === request.targetQuantity) {
            request.finished = true;
            request.completedDate = event.completedDate;
            if (request.type === 'order') order.initialFinished = true;
          }
          break;
        }
        requireThat(!event.deliveryNo, 'この依頼は分納ではありません。分納の回は空にしてください。');
        requireThat(reported === request.targetQuantity,
          '良品部数と不足部数の合計を対象依頼の部数に合わせてください。予定部数は' + copies(request.targetQuantity) +
          '、入力の合計は' + copies(reported) + '（良品' + copies(event.goodQuantity) +
          '＋不足' + copies(event.shortageQuantity) + '）です。');
        request.finished = true;
        request.goodQuantity = Number(event.goodQuantity);
        request.shortageQuantity = Number(event.shortageQuantity);
        request.completedDate = event.completedDate;
        order.goodQuantity += request.goodQuantity;
        if (request.type === 'order') order.initialFinished = true;
        recordFinish(state, event);
        break;
      }
    }
  }

  // 製造完了報告の記録。訂正版（P-038）で元の報告を探し、二重に足さないために使う。
  function recordFinish(state, event) {
    const spare = Number(event.spareQuantity || 0);
    state.finishes.set(event.eventId, { eventId: event.eventId, orderId: event.orderId, requestId: event.requestId,
      deliveryNo: event.deliveryNo || '', goodQuantity: Number(event.goodQuantity), spareQuantity: spare,
      shortageQuantity: Number(event.shortageQuantity), completedDate: event.completedDate,
      correctsEventId: event.correctsEventId || '', supersededBy: '' });
    // 予備部数は報告ごとに足す。訂正版では元の報告の予備部数を差し引いてから足す（二重に足さない）。
    const order = state.orders.get(event.orderId);
    const request = state.requests.get(event.requestId);
    const original = event.correctsEventId ? state.finishes.get(event.correctsEventId) : null;
    const diff = spare - (original ? original.spareQuantity : 0);
    order.spareQuantity = (order.spareQuantity || 0) + diff;
    if (request) request.spareQuantity = (request.spareQuantity || 0) + diff;
  }

  // 完成数の訂正版（P-038）。元の報告の良品・不足部数を訂正版の値に置き換える（差分だけを反映する）。
  // 訂正できるのは、まだ訂正されていない最新の報告だけ。同じ依頼・同じ回の部数の合計に合わせる。
  function correctFinish(state, event, order, request, reported, copies) {
    const original = state.finishes.get(event.correctsEventId);
    requireThat(original && original.orderId === order.id,
      '訂正する元の製造完了報告（' + event.correctsEventId + '）が見つかりません。先に元の報告を読み込んでください。');
    requireThat(!original.supersededBy, 'この製造完了報告はすでに訂正済みです（訂正版：' + original.supersededBy + '）。最新の報告を訂正してください。');
    requireThat(request && event.requestId === original.requestId && (event.deliveryNo || '') === original.deliveryNo,
      '訂正版は、元の報告と同じ依頼・同じ分納の回にしてください。');
    const delivery = original.deliveryNo ? (request.deliveries || []).find(item => item.no === Number(original.deliveryNo)) : null;
    const target = delivery ? delivery.quantity : request.targetQuantity;
    requireThat(reported === target, '良品部数と不足部数の合計を、元の報告と同じ' + copies(target) +
      'に合わせてください。入力の合計は' + copies(reported) + 'です。');
    const goodDiff = Number(event.goodQuantity) - original.goodQuantity;
    const shortageDiff = Number(event.shortageQuantity) - original.shortageQuantity;
    order.goodQuantity += goodDiff;
    request.goodQuantity = (request.goodQuantity || 0) + goodDiff;
    request.shortageQuantity = (request.shortageQuantity || 0) + shortageDiff;
    if (delivery) {
      delivery.goodQuantity = Number(event.goodQuantity);
      delivery.shortageQuantity = Number(event.shortageQuantity);
      delivery.completedDate = event.completedDate;
    }
    if (!delivery || request.finished) request.completedDate = event.completedDate;
    original.supersededBy = event.eventId;
    recordFinish(state, event);
  }

  function eventValues(event) {
    return ['eventId', 'type', ...interfaces[event.type].fields].map(field => event[field]);
  }

  function buildState(events) {
    const state = { orders: new Map(), requests: new Map(), proofs: new Map(), finishes: new Map() };
    const seen = new Map();
    for (const event of events) {
      requireThat(!seen.has(event.eventId), '台帳内でイベントIDが重複しています。');
      applyEvent(state, event);
      seen.set(event.eventId, event);
    }
    return { ...state, seen };
  }

  function mergeEvents(current, incoming) {
    const state = buildState(current);
    const accepted = [];
    let skipped = 0;
    for (const [index, event] of incoming.entries()) {
      try {
        validateEvent(event);
        const old = state.seen.get(event.eventId);
        if (old) {
          requireThat(JSON.stringify(eventValues(old)) === JSON.stringify(eventValues(event)),
            '同じイベントIDに異なる内容があります。');
          skipped++;
          continue;
        }
        applyEvent(state, event);
        state.seen.set(event.eventId, event);
        accepted.push(event);
      } catch (error) {
        throw new Error('データ ' + (index + 1) + ' 件目：' + error.message);
      }
    }
    return { events: [...current, ...accepted], accepted: accepted.length, skipped };
  }

  function encodeCsv(rows) {
    return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"')
      .join(',')).join('\r\n') + '\r\n';
  }

  function decodeCsv(text) {
    const input = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let closed = false;

    function pushField() {
      row.push(field);
      field = '';
      closed = false;
    }

    function pushRow() {
      pushField();
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    }

    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quoted) {
        if (character === '"' && input[index + 1] === '"') {
          field += '"';
          index++;
        } else if (character === '"') {
          quoted = false;
          closed = true;
        } else {
          field += character;
        }
      } else if (character === ',') {
        pushField();
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && input[index + 1] === '\n') index++;
        pushRow();
      } else if (character === '"') {
        requireThat(!closed && !field, 'CSVの引用符の位置が不正です。');
        quoted = true;
      } else {
        requireThat(!closed, 'CSVの閉じ引用符の後に不正な文字があります。');
        field += character;
      }
    }
    requireThat(!quoted, 'CSVの引用符が閉じていません。');
    if (row.length || field || closed) pushRow();
    return rows;
  }

  function exportExchange(type, events) {
    requireThat(!interfaces[type].internal, '製造部内の記録は相手部署へ書き出せません。');
    return encodeCsv([['eventId', 'type', ...interfaces[type].fields], ...events.map(eventValues)]);
  }

  function readExchange(text, receivingDepartment) {
    const [header, ...rows] = decodeCsv(text);
    requireThat(rows.length, 'CSVにデータ行がありません。');
    const type = rows[0][1];
    const definition = Object.hasOwn(interfaces, type) && interfaces[type];
    requireThat(definition && !definition.internal && definition.from !== receivingDepartment,
      '相手部署から受信する種類のCSVを選んでください。');
    const expected = ['eventId', 'type', ...definition.fields];
    requireThat(JSON.stringify(header) === JSON.stringify(expected) || isLegacyHeader(header, expected),
      'CSVの見出しが仕様と一致しません。');
    return rows.map((row, index) => {
      requireThat(row.length === header.length && row[1] === type, 'データ ' + (index + 1) + ' 件目の列数または種類が不正です。');
      return withDefaults(Object.fromEntries(header.map((field, position) => [field, row[position]])));
    });
  }

  // 台帳の先頭には、イベントが0件でも部署が分かるよう、event が空の「部署の行」を必ず入れる（P-041）。
  function exportBackup(department, events) {
    return encodeCsv([['department', 'event'], [department, ''],
      ...events.map(event => [department, JSON.stringify(event)])]);
  }

  function readBackup(department, text) {
    const [header, ...rows] = decodeCsv(text);
    requireThat(JSON.stringify(header) === '["department","event"]', '台帳保存用のCSVを選んでください。');
    // 部署の行もイベントもない台帳（部署の行を入れる前に保存した、注文0件の台帳）は、どの部署のものか分からないので開かない。
    requireThat(rows.length, '注文が0件の古い形式の台帳のため、どの部署の台帳か判別できません。今の台帳はそのままにします。');
    const departments = new Set(rows.map(row => row[0]));
    requireThat(rows.every(row => row.length === 2) && departments.size === 1 && departments.has(department),
      '自部署で保存した台帳を選んでください（' + [...departments].map(name => departmentNames[name] || name).join('・') +
      'の台帳です）。今の台帳はそのままにします。');
    const events = rows.filter(row => row[1] !== '').map(row => withDefaults(JSON.parse(row[1])));
    buildState(events);
    return events;
  }

  const departmentNames = { sales: '営業部', factory: '製造部' };

  globalThis.PrintWorkflow = { interfaces, stages, reasonCodes, availableOrder, buildState, mergeEvents,
    exportExchange, readExchange, exportBackup, readBackup };
})();