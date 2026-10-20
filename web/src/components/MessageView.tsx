import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ChevronDown,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Inbox,
  MailOpen,
  Paperclip,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, patch, type Mailbox, type MessageDetail } from '../api';
import { avatarStyle, fileSize, fullTime, initial, senderLabel } from '../lib/format';
import { useMessageActions, type BatchAction } from '../lib/mail';
import EmailFrame, { hasRemoteContent } from './EmailFrame';
import { useFeedback } from './feedback';
import { Badge, Button, cx, Empty, IconButton, Spinner } from './ui';

const URL_RE = /(https?:\/\/[^\s<>"'）】]+)/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline dark:text-blue-400">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function people(list: Mailbox[]): string {
  return list.map((m) => (m.name ? `${m.name} <${m.address}>` : m.address)).join(', ');
}

function AuthBadge({ label, value }: { label: string; value: string | null }) {
  const tone = value === 'pass' ? 'green' : value === 'fail' ? 'red' : value ? 'amber' : 'zinc';
  return (
    <Badge tone={tone}>
      {label} {value ?? '无'}
    </Badge>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all text-zinc-800 dark:text-zinc-200">{children}</dd>
    </>
  );
}

function AttachmentIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <ImageIcon className="size-5" />;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText className="size-5" />;
  return <Paperclip className="size-5" />;
}

export default function MessageView({
  id,
  onBack,
  onAfterMove,
}: {
  id: number;
  onBack: () => void;
  /** Called after the message leaves the current view (archive, delete, ...). */
  onAfterMove: () => void;
}) {
  const qc = useQueryClient();
  const run = useMessageActions();
  const { confirm } = useFeedback();
  const [showDetails, setShowDetails] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['message', id],
    queryFn: () => api<MessageDetail>(`/mail/messages/${id}`),
    staleTime: 60_000,
  });

  // Mark as read on open.
  const markedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!data || data.message.is_read || markedRef.current === id) return;
    markedRef.current = id;
    run([id], 'read', { silent: true });
  }, [data, id, run]);

  useEffect(() => {
    setAllowRemote(false);
    setShowDetails(false);
    scroller.current?.scrollTo(0, 0);
  }, [id]);

  if (isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white dark:bg-zinc-900">
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex h-full w-full flex-col bg-white dark:bg-zinc-900">
        <div className="flex h-14 items-center px-2 md:hidden">
          <IconButton label="返回" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </IconButton>
        </div>
        <Empty title="无法打开邮件">{error.message}</Empty>
      </div>
    );
  }

  const m = data.message;
  const folder = m.folder;
  const visibleAttachments = data.attachments.filter((a) => !(a.inline && a.content_id && data.html?.includes(`/api/inline/${id}/${a.idx}?`)));
  const remote = data.html ? hasRemoteContent(data.html) : false;
  const authFailed = m.dmarc === 'fail' || m.spf === 'fail';

  const move = async (action: BatchAction) => {
    if (action === 'delete') {
      const ok = await confirm({ title: '彻底删除', message: '将永久删除这封邮件及其附件，无法恢复。', confirmText: '彻底删除', danger: true });
      if (!ok) return;
    }
    onAfterMove();
    await run([id], action);
  };

  const markUnread = async () => {
    markedRef.current = id;
    await run([id], 'unread', { silent: true });
    onBack();
  };

  const toggleStar = async () => {
    await patch(`/mail/messages/${id}`, { is_starred: !m.is_starred });
    qc.setQueryData<MessageDetail>(['message', id], (d) => (d ? { ...d, message: { ...d.message, is_starred: !m.is_starred } } : d));
    qc.invalidateQueries({ queryKey: ['messages'] });
  };

  return (
    <div className="flex h-full w-full flex-col bg-white dark:bg-zinc-900">
      <div className="flex h-14 shrink-0 items-center gap-0.5 border-b border-zinc-200 px-2 pt-[env(safe-area-inset-top)] box-content sm:px-3 dark:border-zinc-800">
        <IconButton label="返回列表" onClick={onBack} className="md:hidden">
          <ArrowLeft className="size-5" />
        </IconButton>
        {folder === 'inbox' ? (
          <IconButton label="归档" onClick={() => move('archive')}>
            <Archive className="size-[18px]" />
          </IconButton>
        ) : (
          <IconButton label="移回收件箱" onClick={() => move('inbox')}>
            <Inbox className="size-[18px]" />
          </IconButton>
        )}
        {folder !== 'spam' && (
          <IconButton label="标记为垃圾邮件" onClick={() => move('spam')}>
            <ShieldAlert className="size-[18px]" />
          </IconButton>
        )}
        {folder === 'trash' || folder === 'spam' ? (
          <IconButton label="彻底删除" onClick={() => move('delete')} className="hover:text-red-600">
            <Trash2 className="size-[18px]" />
          </IconButton>
        ) : (
          <IconButton label="删除" onClick={() => move('trash')}>
            <Trash2 className="size-[18px]" />
          </IconButton>
        )}
        <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
        <IconButton label="标为未读" onClick={markUnread}>
          <MailOpen className="size-[18px]" />
        </IconButton>
        <IconButton label={m.is_starred ? '取消星标' : '加星标'} onClick={toggleStar} className={m.is_starred ? 'text-amber-400 hover:text-amber-500' : ''}>
          <Star className="size-[18px]" fill={m.is_starred ? 'currentColor' : 'none'} />
        </IconButton>
        <div className="ml-auto flex items-center">
          <IconButton label="查看原始邮件" onClick={() => window.open(`/api/mail/messages/${id}/raw`, '_blank', 'noopener')}>
            <FileCode2 className="size-[18px]" />
          </IconButton>
          <IconButton label="下载 .eml" onClick={() => (window.location.href = `/api/mail/messages/${id}/raw?download=1`)}>
            <Download className="size-[18px]" />
          </IconButton>
        </div>
      </div>

      <div ref={scroller} className="pane-scroll flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6">
          <h1 className="text-xl leading-snug font-semibold break-words text-zinc-900 dark:text-white">{m.subject || '(无主题)'}</h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {folder !== 'inbox' && <Badge>{{ archive: '已归档', spam: '垃圾邮件', trash: '回收站', inbox: '' }[folder]}</Badge>}
            <Badge tone="blue">收件：{m.address}</Badge>
          </div>

          {authFailed && (
            <div className="mt-4 flex gap-2.5 rounded-lg bg-red-50 px-3.5 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>这封邮件没有通过发件人身份验证（{m.dmarc === 'fail' ? 'DMARC' : 'SPF'} 失败），发件人可能是伪造的。不要轻信其中的链接或付款要求。</div>
            </div>
          )}
          {m.status !== 'ready' && (
            <div className="mt-4 flex gap-2.5 rounded-lg bg-amber-50 px-3.5 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                {m.status === 'pending' ? '邮件还在处理中，稍后刷新即可看到正文。' : `邮件解析失败：${m.parse_error ?? '未知错误'}。可以下载原文查看。`}
              </div>
            </div>
          )}

          <div className="mt-5 flex gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={avatarStyle(m.from_addr)}>
              {initial(m.from_name, m.from_addr)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-zinc-900 dark:text-white">{senderLabel(m.from_name, m.from_addr)}</span>
                {m.from_name && <span className="text-sm break-all text-zinc-500">&lt;{m.from_addr}&gt;</span>}
              </div>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="mt-0.5 inline-flex max-w-full items-center gap-1 text-left text-[13px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
              >
                <span className="truncate">发给 {m.to.length ? people(m.to) : m.address}</span>
                <ChevronDown className={cx('size-3.5 shrink-0 transition-transform', showDetails && 'rotate-180')} />
              </button>
              <div className="mt-0.5 text-xs text-zinc-500 sm:hidden">{fullTime(m.sent_at ?? m.received_at)}</div>
            </div>
            <div className="hidden shrink-0 pt-0.5 text-right text-xs text-zinc-500 sm:block">{fullTime(m.sent_at ?? m.received_at)}</div>
          </div>

          {showDetails && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-zinc-50 px-4 py-3 text-[13px] dark:bg-zinc-800/50">
              <DetailRow label="发件人">{m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}</DetailRow>
              {m.to.length > 0 && <DetailRow label="收件人">{people(m.to)}</DetailRow>}
              {m.cc.length > 0 && <DetailRow label="抄送">{people(m.cc)}</DetailRow>}
              {m.reply_to && <DetailRow label="回复地址">{m.reply_to}</DetailRow>}
              <DetailRow label="投递地址">{m.address}</DetailRow>
              <DetailRow label="信封发件人">{m.envelope_from || '—'}</DetailRow>
              <DetailRow label="接收时间">{fullTime(m.received_at)}</DetailRow>
              <DetailRow label="大小">{fileSize(m.size)}</DetailRow>
              <DetailRow label="验证">
                <span className="flex flex-wrap gap-1">
                  <AuthBadge label="SPF" value={m.spf} />
                  <AuthBadge label="DKIM" value={m.dkim} />
                  <AuthBadge label="DMARC" value={m.dmarc} />
                </span>
              </DetailRow>
              {m.message_id_hdr && <DetailRow label="Message-ID">{m.message_id_hdr}</DetailRow>}
            </dl>
          )}

          {remote && !allowRemote && (
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-zinc-100 px-3.5 py-2.5 text-[13px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              <ImageIcon className="size-4 shrink-0" />
              <span className="flex-1">为保护隐私，已阻止加载远程图片。</span>
              <Button size="sm" onClick={() => setAllowRemote(true)}>
                显示图片
              </Button>
            </div>
          )}

          <div className="mt-5">
            {data.html ? (
              <EmailFrame html={data.html} allowRemote={allowRemote} />
            ) : data.text ? (
              <div className="rounded-xl px-1 text-[14px] leading-relaxed break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                <Linkified text={data.text} />
              </div>
            ) : m.status === 'ready' ? (
              <p className="text-sm text-zinc-500">(邮件没有正文)</p>
            ) : null}
          </div>

          {visibleAttachments.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                <Paperclip className="size-4" />
                {visibleAttachments.length} 个附件
              </h2>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {visibleAttachments.map((a) => (
                  <li key={a.idx} className="flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-zinc-200 dark:ring-zinc-800">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
                      <AttachmentIcon mime={a.mime} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={a.filename}>
                        {a.filename || `附件 ${a.idx + 1}`}
                      </div>
                      <div className="text-xs text-zinc-500">{fileSize(a.size)}</div>
                    </div>
                    {a.previewable && (
                      <a
                        href={`/api/mail/messages/${id}/attachments/${a.idx}?inline=1`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="预览"
                        aria-label="预览"
                        className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                    <a
                      href={`/api/mail/messages/${id}/attachments/${a.idx}`}
                      title="下载"
                      aria-label="下载"
                      className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <Download className="size-4" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
