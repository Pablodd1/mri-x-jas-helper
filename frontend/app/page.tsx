"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload, Mic, FileImage, Brain, Microscope,
  Zap, FileText, AlertTriangle, CheckCircle2,
  Loader2, ChevronDown, X, RefreshCw, Stethoscope
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalysisResult {
  request_id: string;
  mode: string;
  report: string;
  quick_summary: string;
  provider: string;
  model: string;
  metadata: {
    modality: string;
    body_part: string;
    rows: number;
    columns: number;
    window_center: number;
    window_width: number;
  };
  estimated_cost_usd: number;
  success: boolean;
  error?: string;
}

interface HealthStatus {
  status: string;
  providers: {
    ollama: boolean;
    kimi: boolean;
    minimax: boolean;
    deepgram: boolean;
  };
  version: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

const CLINICAL_QUESTIONS = [
  "General chest X-ray review",
  "ACL tear evaluation",
  "Meniscus injury assessment",
  "Brain tumor screening",
  "Stroke assessment",
  "Cervical spine evaluation",
  "Lung nodule detection",
  "Liver lesion characterization",
  "Custom...",
];

const BODY_PARTS = ["CHEST", "BRAIN", "MSK (Knee/Shoulder)", "SPINE", "ABDOMEN", "OTHER"];

const MODES = [
  {
    id: "quick_scan",
    label: "Quick Scan",
    icon: Zap,
    desc: "< 10 seconds, free with Ollama",
    color: "text-amber-600",
  },
  {
    id: "deep_analysis",
    label: "Deep Analysis",
    icon: Brain,
    desc: "Comprehensive report, uses Kimi/MiniMax",
    color: "text-primary-600",
  },
];

const PROVIDERS = [
  { id: "modal", label: "Modal (Cloud GPU)", desc: "No local machine needed", requiresKey: false },
  { id: "ollama", label: "Ollama (Local)", desc: "Free, uses your GPU", requiresKey: false },
  { id: "kimi", label: "Kimi (Moonshot)", desc: "Affordable cloud AI", requiresKey: true },
  { id: "minimax", label: "MiniMax", desc: "Cost-effective fallback", requiresKey: true },
];

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function checkHealth(): Promise<HealthStatus | null> {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function analyzeImage(
  file: File,
  clinicalQuestion: string,
  mode: string,
  provider: string,
  tags: string[]
): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("clinical_question", clinicalQuestion);
  formData.append("mode", mode);
  formData.append("preferred_provider", provider);
  formData.append("tags", JSON.stringify(tags));

  const res = await fetch(`${API_URL}/api/analyze`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }

  return await res.json();
}

async function transcribeAudio(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("audio", file);

  const res = await fetch(`${API_URL}/api/transcribe`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error("Transcription failed");
  const data = await res.json();
  return data.transcript;
}

// ─── Components ───────────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center">
            <Stethoscope className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">MRI X Jas Helper</h1>
            <p className="text-xs text-slate-500">AI Radiology Second Opinion</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="status-live active" />
            API Connected
          </div>
        </div>
      </div>
    </header>
  );
}

function DropZone({
  file,
  setFile,
  preview,
  setPreview,
}: {
  file: File | null;
  setFile: (f: File) => void;
  preview: string | null;
  setPreview: (p: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setPreview(URL.createObjectURL(dropped));
    }
  }, [setFile, setPreview]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setPreview(URL.createObjectURL(selected));
    }
  };

  return (
    <div
      className={`drop-zone p-8 text-center ${isDragging ? "active" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".dcm,.nii,.nii.gz,.png,.jpg,.jpeg"
        className="hidden"
        onChange={handleFileChange}
      />

      {file && preview ? (
        <div className="relative">
          <img
            src={preview}
            alt="Preview"
            className="max-h-64 mx-auto rounded-lg object-contain"
          />
          <button
            className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
            onClick={(e) => {
              e.stopPropagation();
              setFile(null as any);
              setPreview(null);
            }}
          >
            <X className="w-4 h-4" />
          </button>
          <p className="mt-3 text-sm text-slate-500 font-mono">{file.name}</p>
        </div>
      ) : (
        <>
          <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">Drop medical image here</p>
          <p className="text-sm text-slate-400 mt-1">
            DICOM (.dcm), NIfTI (.nii), PNG, JPG — or click to browse
          </p>
        </>
      )}
    </div>
  );
}

function ModeSelector({ mode, setMode }: { mode: string; setMode: (m: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {MODES.map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            className={`p-4 rounded-xl border-2 text-left transition-all ${
              mode === m.id
                ? "border-primary-600 bg-primary-50"
                : "border-slate-200 hover:border-slate-300"
            }`}
            onClick={() => setMode(m.id)}
          >
            <Icon className={`w-5 h-5 mb-2 ${mode === m.id ? m.color : "text-slate-400"}`} />
            <p className={`font-semibold text-sm ${mode === m.id ? "text-primary-700" : "text-slate-700"}`}>
              {m.label}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">{m.desc}</p>
          </button>
        );
      })}
    </div>
  );
}

function ProviderSelector({ provider, setProvider, health }: {
  provider: string;
  setProvider: (p: string) => void;
  health: HealthStatus | null;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PROVIDERS.map((p) => {
        const available = health?.providers?.[p.id as keyof typeof health.providers];
        return (
          <button
            key={p.id}
            disabled={!available}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
              provider === p.id
                ? "border-primary-600 bg-primary-600 text-white"
                : available
                  ? "border-slate-200 text-slate-600 hover:border-slate-300"
                  : "border-slate-100 text-slate-300 cursor-not-allowed"
            }`}
            onClick={() => available && setProvider(p.id)}
            title={available ? p.desc : `${p.label} not configured`}
          >
            {p.label}
            {!available && (
              <span className="ml-1 text-xs text-slate-400">(offline)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ReportDisplay({ result }: { result: AnalysisResult }) {
  if (!result.success) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6">
        <div className="flex items-center gap-2 text-red-700 font-semibold mb-2">
          <AlertTriangle className="w-5 h-5" />
          Analysis Failed
        </div>
        <p className="text-sm text-red-600 font-mono">{result.error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Quick summary banner */}
      {result.quick_summary && (
        <div className="bg-primary-50 border border-primary-200 rounded-xl p-4 animate-slide-up">
          <div className="flex items-center gap-2 text-primary-700 font-semibold mb-2">
            <CheckCircle2 className="w-4 h-4" />
            AI Quick Scan Result
          </div>
          <p className="text-sm text-primary-800">{result.quick_summary}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Modality", value: result.metadata?.modality || "—" },
          { label: "Body Part", value: result.metadata?.body_part || "—" },
          { label: "Resolution", value: result.metadata ? `${result.metadata.rows}×${result.metadata.columns}` : "—" },
          { label: "AI Provider", value: result.provider || "—" },
        ].map((item) => (
          <div key={item.label} className="bg-white border border-slate-200 rounded-lg p-3">
            <p className="text-xs text-slate-400 uppercase tracking-wide">{item.label}</p>
            <p className="text-sm font-semibold text-slate-800 mt-0.5 font-mono">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Full report */}
      {result.report && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-semibold text-slate-600">Full Radiological Report</span>
            {result.estimated_cost_usd > 0 && (
              <span className="text-xs text-slate-400 ml-auto">
                Est. cost: ${result.estimated_cost_usd.toFixed(4)}
              </span>
            )}
          </div>
          <div className="report-box animate-fade-in">
            {result.report}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [clinicalQuestion, setClinicalQuestion] = useState(CLINICAL_QUESTIONS[0]);
  const [customQuestion, setCustomQuestion] = useState("");
  const [mode, setMode] = useState("quick_scan");
  const [provider, setProvider] = useState("ollama");
  const [tags, setTags] = useState<string[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);

  // Voice recording
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);

  // Check health on mount
  useEffect(() => {
    checkHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  // Voice recording
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      setMediaRecorder(mr);
      setAudioChunks([]);

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) {
          setAudioChunks((prev) => [...prev, e.data]);
        }
      };

      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        try {
          const transcript = await transcribeAudio(new File([blob], "recording.webm", { type: "audio/webm" }));
          setCustomQuestion(transcript);
          setClinicalQuestion("Custom...");
        } catch {
          alert("Transcription failed. Make sure the API is running.");
        }
      };

      mr.start();
      setRecording(true);
    } catch {
      alert("Microphone access denied.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
    }
  };

  const handleAnalyze = async () => {
    if (!file) {
      alert("Please upload an image first.");
      return;
    }

    const question = clinicalQuestion === "Custom..." ? customQuestion : clinicalQuestion;
    if (!question || question === "Custom...") {
      alert("Please enter a clinical question.");
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const res = await analyzeImage(file, question, mode, provider, tags);
      setResult(res);
    } catch (e: any) {
      setResult({
        request_id: "",
        mode,
        report: "",
        quick_summary: "",
        provider: "error",
        model: "",
        metadata: { modality: "", body_part: "", rows: 0, columns: 0, window_center: 0, window_width: 0 },
        estimated_cost_usd: 0,
        success: false,
        error: e.message || "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Provider status bar */}
        <div className="flex flex-wrap items-center gap-3 mb-6 text-xs">
          <span className="text-slate-500 font-medium">AI Providers:</span>
          {[
            { key: "modal", label: "Modal GPU" },
            { key: "ollama", label: "Ollama" },
            { key: "kimi", label: "Kimi" },
            { key: "minimax", label: "MiniMax" },
            { key: "deepgram", label: "Deepgram" },
          ].map((p) => {
            const active = health?.providers?.[p.key as keyof typeof health.providers];
            return (
              <span key={p.key} className={`px-2 py-1 rounded-full font-mono ${
                active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
              }`}>
                {p.label}: {active ? "✓" : "✗"}
              </span>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LEFT COLUMN — Input */}
          <div className="space-y-5">
            {/* Drop Zone */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <FileImage className="w-4 h-4" />
                Upload Medical Image
              </h2>
              <DropZone file={file} setFile={setFile} preview={preview} setPreview={setPreview} />
            </div>

            {/* Clinical Question */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <Microscope className="w-4 h-4" />
                Clinical Question
              </h2>
              <div className="relative">
                <select
                  value={clinicalQuestion}
                  onChange={(e) => setClinicalQuestion(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {CLINICAL_QUESTIONS.map((q) => (
                    <option key={q} value={q}>{q}</option>
                  ))}
                </select>
              </div>

              {clinicalQuestion === "Custom..." && (
                <textarea
                  value={customQuestion}
                  onChange={(e) => setCustomQuestion(e.target.value)}
                  placeholder="Describe what you're looking for..."
                  className="w-full mt-3 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                  rows={3}
                />
              )}

              {/* Voice input */}
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={recording ? stopRecording : startRecording}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    recording
                      ? "bg-red-500 text-white animate-pulse"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  <Mic className="w-4 h-4" />
                  {recording ? "Stop Recording" : "Voice Input"}
                </button>
                {recording && (
                  <span className="text-xs text-red-500 animate-pulse">Recording... speak your clinical question</span>
                )}
              </div>
            </div>

            {/* Analysis Mode */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Analysis Mode
              </h2>
              <ModeSelector mode={mode} setMode={setMode} />
            </div>

            {/* Provider */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <Brain className="w-4 h-4" />
                AI Provider
              </h2>
              <ProviderSelector provider={provider} setProvider={setProvider} health={health} />
            </div>

            {/* Analyze Button */}
            <button
              onClick={handleAnalyze}
              disabled={!file || loading}
              className={`w-full py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-3 ${
                file && !loading
                  ? "bg-primary-600 text-white hover:bg-primary-700 shadow-lg shadow-primary-200"
                  : "bg-slate-200 text-slate-400 cursor-not-allowed"
              }`}
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Brain className="w-5 h-5" />
                  Analyze Image
                </>
              )}
            </button>

            {result?.error && (
              <p className="text-sm text-red-500 text-center">{result.error}</p>
            )}
          </div>

          {/* RIGHT COLUMN — Results */}
          <div className="space-y-5">
            {result ? (
              <div className="animate-slide-up">
                <ReportDisplay result={result} />
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center shadow-sm">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Brain className="w-8 h-8 text-slate-300" />
                </div>
                <h3 className="text-slate-500 font-medium mb-1">No analysis yet</h3>
                <p className="text-sm text-slate-400">
                  Upload an image and click Analyze to get AI-powered insights
                </p>
              </div>
            )}

            {/* Disclaimer */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Educational & Research Use Only</p>
                  <p className="text-xs text-amber-700 mt-1">
                    This tool is an AI assistant and is <strong>NOT</strong> a certified medical device.
                    All analysis must be reviewed by a qualified radiologist before any clinical decisions.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
