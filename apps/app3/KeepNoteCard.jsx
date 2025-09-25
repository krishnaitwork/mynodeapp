import React, { useState } from 'react';
import { Pin, Copy, Eye, EyeOff, Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { hasSensitiveContent, maskSensitiveContent, default as sensitiveConfig } from '../config/sensitiveConfig';

const KeepNoteCard = ({ note, onEdit, onDelete, onTogglePin, onToggleArchive }) => {
  const [showPassword, setShowPassword] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return (
      date.toLocaleDateString() +
      " " +
      date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  };

  const getCategoryColor = (category) => {
    const colors = {
      Work: "#1a73e8",
      Personal: "#e67c73",
      Home: "#34a853",
      Finance: "#fbbc04",
    };

    if (!colors[category]) {
      let hash = 0;
      for (let i = 0; i < category.length; i++) {
        hash = category.charCodeAt(i) + ((hash << 5) - hash);
      }
      const palette = [
        "#1a73e8",
        "#e67c73",
        "#fbbc04",
        "#34a853",
        "#a142f4",
        "#ff7043",
      ];
      return palette[Math.abs(hash) % palette.length];
    }

    return colors[category];
  };

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      const textToCopy = note.title ? `${note.title}\n\n${note.content}` : note.content;
      await navigator.clipboard.writeText(textToCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 1200);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  const handleAction = (e, action) => {
    e.stopPropagation();
    action();
  };

  const renderContent = () => {
    let content = note.content;
    const isSensitive = hasSensitiveContent(content);

    if (isSensitive && !showPassword) {
      content = maskSensitiveContent(content);
    }

    content = content.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline;">$1</a>');

    return content;
  };

  const hasPassword = hasSensitiveContent(note.content) || !!note.is_password;

  const minHeight = sensitiveConfig.noteCardMinHeight || 200;
  const maxContentHeight = sensitiveConfig.noteCardMaxContentHeight || 220;

  return (
    <div
      className={`group bg-white dark:bg-gray-900 text-foreground rounded-xl p-4 shadow-sm border transition-all cursor-pointer flex flex-col relative hover:border-primary hover:shadow-md ${note.pinned ? "border-yellow-400" : "border-border"}`}
      onClick={() => onEdit(note)}
      style={{ minHeight: `${minHeight}px` }}
    >
      <div className="flex justify-between items-start mb-2 gap-2">
        <div className="font-semibold text-lg text-primary line-clamp-2 flex-1 pr-2">
          {note.title || "(No Title)"}
        </div>
        <span className="text-white px-2 py-1 rounded-full text-xs font-medium flex-shrink-0" style={{ backgroundColor: getCategoryColor(note.category) }}>
          {note.category}
        </span>
      </div>

  <div className="flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words mb-2 overflow-hidden" style={{ maxHeight: `${maxContentHeight}px` }} dangerouslySetInnerHTML={{ __html: renderContent() }} />

      {hasPassword && (
        <button className="absolute top-3 right-16 bg-transparent border-none cursor-pointer p-1 rounded text-foreground transition-colors hover:bg-accent opacity-100 z-10" onClick={(e) => { e.stopPropagation(); setShowPassword(!showPassword); }} title={showPassword ? "Hide Password" : "Show Password"}>
          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}

      <div className="flex justify-between items-center gap-2 mt-auto pt-1">
        <span className="text-[15px] text-muted-foreground flex-shrink-0 tracking-tight">{formatDate(note.LastModifiedDate)}</span>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity translate-y-0.5">
          <button className={`bg-transparent border-none cursor-pointer p-1 rounded-full transition-all hover:bg-accent hover:scale-105 ${note.pinned ? "text-yellow-500" : "text-foreground"}`} onClick={(e) => handleAction(e, () => onTogglePin(note.id))} title={note.pinned ? "Unpin" : "Pin"}>
            <Pin size={14} />
          </button>

          <button className="bg-transparent border-none cursor-pointer p-1 rounded-full text-foreground transition-all hover:bg-accent hover:scale-105" onClick={handleCopy} title="Copy Note" style={{ color: copySuccess ? "#22c55e" : "var(--foreground)" }}>
            <Copy size={14} />
          </button>

          <button className="bg-transparent border-none cursor-pointer p-1 rounded-full text-foreground transition-all hover:bg-accent hover:scale-105" onClick={(e) => handleAction(e, () => onToggleArchive(note.id))} title={note.archived ? "Unarchive" : "Archive"}>
            {note.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>

          <button className="bg-transparent border-none cursor-pointer p-1 rounded-full text-red-500 transition-all hover:bg-accent hover:scale-105" onClick={(e) => handleAction(e, () => onDelete(note))} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default KeepNoteCard;