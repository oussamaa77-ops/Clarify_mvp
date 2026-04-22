"use client";

import { useState, useEffect } from "react";
import { Calculator, FileText, CheckCircle, AlertCircle, BookOpen, Shield, Clock } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type Tab = "ledger" | "journal";
type JournalStatus = "DRAFT" | "POSTED";

function StatusBadge({ status }: { status: JournalStatus }) {
  if (status === "POSTED") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
        <CheckCircle className="w-3 h-3" />Validée
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
      <Clock className="w-3 h-3" />En attente
    </span>
  );
}

export default function AccountingPage() {
  const [activeTab, setActiveTab] = useState<Tab>("ledger");
  const [ledger, setLedger] = useState<any[]>([]);
  const [journal, setJournal] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [validating, setValidating] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [userRole, setUserRole] = useState<string>("");

useEffect(() => {
  setMounted(true);
  fetchData();
  apiFetch("/auth/me").then((u: any) => setUserRole(u?.dossier_role || ""));
}, []);

  const fetchData = async () => {
    try {
      setIsLoading(true);
      const [ledgerData, journalData] = await Promise.all([
        apiFetch("/accounting/ledger"),
        apiFetch("/accounting/journal"),
      ]);
      setLedger(ledgerData || []);
      setJournal(journalData || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des données. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleValidate = async (entryId: number) => {
    setValidating(entryId);
    try {
      const updated = await apiFetch(`/accounting/journal/${entryId}/validate`, {
        method: "POST",
        body: {},
      });
      setJournal(prev => prev.map(e => e.id === entryId ? { ...e, status: "POSTED", validated_at: updated.validated_at } : e));
    } catch (err: any) {
      setError("Erreur de validation : " + err.message);
    } finally {
      setValidating(null);
    }
  };

  if (!mounted) return null;

  const totalLedgerDebit = ledger.reduce((acc, row) => acc + (row.total_debit || 0), 0);
  const totalLedgerCredit = ledger.reduce((acc, row) => acc + (row.total_credit || 0), 0);
  const isBalanced = Math.abs(totalLedgerDebit - totalLedgerCredit) < 0.01;

  const filteredJournal = statusFilter === "ALL"
    ? journal
    : journal.filter(e => e.status === statusFilter);

  const draftCount = journal.filter(e => e.status === "DRAFT").length;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Comptabilité</h1>
          <p className="text-sm text-slate-500 mt-1">Grand Livre, Journal des écritures et validation.</p>
        </div>
        {draftCount > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
            <Clock className="w-4 h-4" />
            <strong>{draftCount}</strong> écriture{draftCount > 1 ? "s" : ""} en attente de validation
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />{error}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab("ledger")}
            className={`${activeTab === "ledger" ? "border-blue-500 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center`}
          >
            <BookOpen className="w-4 h-4 mr-2" />Grand Livre (Balance)
          </button>
          <button
            onClick={() => setActiveTab("journal")}
            className={`${activeTab === "journal" ? "border-blue-500 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2`}
          >
            <FileText className="w-4 h-4" />Journal des écritures
            {draftCount > 0 && (
              <span className="ml-1 px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full text-xs font-bold">
                {draftCount}
              </span>
            )}
          </button>
        </nav>
      </div>

      {isLoading ? (
        <div className="py-12 flex justify-center items-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : activeTab === "ledger" ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-sm font-medium text-slate-500 mb-1">Total Débit</p>
              <h3 className="text-2xl font-bold text-slate-800">{totalLedgerDebit.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</h3>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-sm font-medium text-slate-500 mb-1">Total Crédit</p>
              <h3 className="text-2xl font-bold text-slate-800">{totalLedgerCredit.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD</h3>
            </div>
            <div className={`p-6 rounded-xl border shadow-sm flex flex-col justify-center ${isBalanced ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
              <div className="flex items-center space-x-2 mb-1">
                {isBalanced ? <CheckCircle className="w-5 h-5 text-green-600" /> : <AlertCircle className="w-5 h-5 text-red-600" />}
                <p className="text-sm font-medium">{isBalanced ? "Balance Équilibrée" : "Déséquilibre"}</p>
              </div>
              <h3 className="text-2xl font-bold">{Math.abs(totalLedgerDebit - totalLedgerCredit).toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD {isBalanced ? "" : "d'écart"}</h3>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm font-medium">
                    <th className="py-3 px-6">N° Compte</th>
                    <th className="py-3 px-6">Intitulé</th>
                    <th className="py-3 px-6 text-right">Débit</th>
                    <th className="py-3 px-6 text-right">Crédit</th>
                    <th className="py-3 px-6 text-right">Solde</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.map((acc, i) => (
                    <tr key={acc.id || i} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-6 text-sm font-bold text-slate-700">{acc.code}</td>
                      <td className="py-3 px-6 text-sm text-slate-600">{acc.name}</td>
                      <td className="py-3 px-6 text-sm text-slate-900 text-right font-medium">{(acc.total_debit || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}</td>
                      <td className="py-3 px-6 text-sm text-slate-900 text-right font-medium">{(acc.total_credit || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}</td>
                      <td className={`py-3 px-6 text-sm text-right font-bold ${acc.balance > 0 ? "text-blue-600" : acc.balance < 0 ? "text-rose-600" : "text-slate-500"}`}>
                        {(acc.balance || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                  {ledger.length === 0 && (
                    <tr><td colSpan={5} className="py-12 text-center text-slate-500">Aucune donnée trouvée.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Filtre statut */}
          <div className="flex gap-2">
            {[
              { val: "ALL",   label: "Toutes" },
              { val: "DRAFT", label: "En attente" },
              { val: "POSTED",label: "Validées" },
            ].map(({ val, label }) => (
              <button key={val} onClick={() => setStatusFilter(val)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  statusFilter === val
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}>
                {label}
                {val === "DRAFT" && draftCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 text-amber-900 rounded-full text-xs">{draftCount}</span>
                )}
              </button>
            ))}
          </div>

          {filteredJournal.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-500 shadow-sm">
              Aucune écriture trouvée.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredJournal.map((entry) => (
                <div key={entry.id} className={`bg-white border rounded-xl shadow-sm overflow-hidden ${
                  entry.status === "DRAFT" ? "border-amber-200" : "border-slate-200"
                }`}>
                  <div className={`px-4 py-3 border-b flex flex-wrap justify-between items-center gap-2 ${
                    entry.status === "DRAFT" ? "bg-amber-50 border-amber-100" : "bg-slate-50 border-slate-200"
                  }`}>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-bold text-slate-700 bg-white px-2 py-1 border border-slate-200 rounded shadow-sm">
                        {entry.date}
                      </span>
                      <span className="text-sm font-medium text-slate-800">{entry.description}</span>
                      {entry.source && (
                        <span className="text-xs text-slate-400 font-mono">[{entry.source}]</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={entry.status} />
                      {entry.reference && (
                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                          {entry.reference}
                        </span>
                      )}
                      {entry.status === "DRAFT" && userRole === "CABINET" && (
  <button
    onClick={() => handleValidate(entry.id)}
    disabled={validating === entry.id}
    title="Valider l'écriture comptable"
    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors">
    {validating === entry.id
      ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
      : <Shield className="w-3 h-3" />
    }
    Valider
  </button>
)}
{entry.status === "DRAFT" && userRole !== "CABINET" && (
  <span className="text-xs text-slate-400 italic">
    Validation réservée au cabinet
  </span>
)}
                    </div>
                  </div>
                  <div className="p-0">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-xs text-slate-400 uppercase tracking-wider bg-white border-b border-slate-100">
                          <th className="py-2 px-4 w-24">Compte</th>
                          <th className="py-2 px-4">Libellé</th>
                          <th className="py-2 px-4 text-right w-36">Débit</th>
                          <th className="py-2 px-4 text-right w-36">Crédit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {entry.lines?.map((line: any) => (
                          <tr key={line.id} className="hover:bg-slate-50">
                            <td className="py-2 px-4 text-sm font-medium text-slate-600">{line.account?.code}</td>
                            <td className="py-2 px-4 text-sm text-slate-500">{line.account?.name}</td>
                            <td className="py-2 px-4 text-sm text-slate-900 text-right">
                              {line.debit > 0 ? line.debit.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) : "—"}
                            </td>
                            <td className="py-2 px-4 text-sm text-slate-900 text-right">
                              {line.credit > 0 ? line.credit.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


type Tab = "ledger" | "journal";
