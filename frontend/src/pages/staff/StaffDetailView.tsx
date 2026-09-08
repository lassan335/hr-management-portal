import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { staffApi, uploadStaffDocument } from "../../lib/staffApi";
import type {
  StaffDetail,
  StaffSummaryRow,
  BankDetail,
  StatusHistoryEntry,
  Qualification,
  Department,
} from "../../lib/staffApi";

const SELF_EDITABLE_FIELDS = ["contactNumber", "personalEmail", "homeAddress", "emergencyContact"];
const LOCKED_FIELDS = [
  "nationalId",
  "employmentType",
  "departmentId",
  "designation",
  "dateJoined",
  "contractEndDate",
];

function isFullDetail(s: StaffDetail | StaffSummaryRow): s is StaffDetail {
  return "contactNumber" in s;
}

export function StaffDetailView({ targetId }: { targetId: string }) {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffDetail | StaffSummaryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isSelf = user?.staffId === targetId;
  const isHr = user?.role === Role.HR_ADMIN;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const detail = isSelf ? await staffApi.getMe() : await staffApi.getById(targetId);
      setStaff(detail);
    } catch {
      setError("Failed to load staff record — you may not have access.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  if (loading) return <p className="text-slate-500 text-sm">Loading…</p>;
  if (error || !staff) return <p className="text-red-600 text-sm">{error ?? "Not found."}</p>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">{staff.fullName}</h1>
        <p className="text-slate-500 text-sm">
          {staff.staffId} · {staff.designation} · {staff.status}
        </p>
      </div>

      {message && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">{message}</p>}

      {isFullDetail(staff) ? (
        <ProfileSection
          staff={staff}
          isSelf={isSelf}
          isHr={isHr}
          onChanged={(msg) => {
            setMessage(msg);
            load();
          }}
        />
      ) : (
        <p className="text-slate-500 text-sm">
          Limited view (department summary only) — full profile fields are visible to HR/Admin
          and the staff member themself.
        </p>
      )}

      {isHr && isFullDetail(staff) && (
        <RoleAccessSection
          targetId={targetId}
          currentRole={staff.role}
          currentDepartmentId={staff.departmentId}
          currentCanSupervise={staff.canSupervise}
          currentCategory={staff.category}
          isSelf={isSelf}
          onChanged={(msg) => {
            setMessage(msg);
            load();
          }}
        />
      )}
      {isHr && <BankDetailsSection targetId={targetId} onChanged={setMessage} />}
      {isHr && <StatusSection targetId={targetId} currentStatus={staff.status} onChanged={setMessage} />}
      <QualificationsSection targetId={targetId} canEdit={isSelf || isHr} />
      <DocumentsSection targetId={targetId} canEdit={isSelf || isHr} isHr={isHr} />
    </div>
  );
}

function ProfileSection({
  staff,
  isSelf,
  isHr,
  onChanged,
}: {
  staff: StaffDetail;
  isSelf: boolean;
  isHr: boolean;
  onChanged: (msg: string) => void;
}) {
  const [editField, setEditField] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fields: { key: keyof StaffDetail; label: string }[] = [
    { key: "personalEmail", label: "Personal email" },
    { key: "contactNumber", label: "Contact number" },
    { key: "homeAddress", label: "Home address" },
    { key: "emergencyContact", label: "Emergency contact" },
    { key: "nationalId", label: "National ID" },
    { key: "employmentType", label: "Employment type" },
    { key: "designation", label: "Designation" },
    { key: "dateJoined", label: "Date joined" },
    { key: "contractEndDate", label: "Contract end date" },
  ];

  async function submit(field: string) {
    setSubmitting(true);
    try {
      if (SELF_EDITABLE_FIELDS.includes(field) && isSelf) {
        await staffApi.selfUpdate({ [field]: value });
        onChanged(`Updated ${field}.`);
      } else {
        await staffApi.submitEditRequest(staff.id, field, value);
        onChanged(`Edit request submitted for ${field} — pending HR approval.`);
      }
      setEditField(null);
      setValue("");
    } catch (e) {
      onChanged((e as Error).message || "Failed to submit change.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-3">Profile</h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        {fields.map(({ key, label }) => {
          const canEditField =
            (isSelf && SELF_EDITABLE_FIELDS.includes(key)) ||
            (isSelf && LOCKED_FIELDS.includes(key)) ||
            isHr;
          const raw = staff[key];
          const display = raw === null || raw === undefined || raw === "" ? "—" : String(raw);
          return (
            <div key={key} className="flex items-start justify-between gap-2">
              <div>
                <dt className="text-slate-400">{label}</dt>
                <dd>{display}</dd>
              </div>
              {canEditField && editField !== key && (
                <button
                  className="text-xs text-brand-600 hover:underline shrink-0"
                  onClick={() => {
                    setEditField(key);
                    setValue(display === "—" ? "" : display);
                  }}
                >
                  {LOCKED_FIELDS.includes(key) && !isHr ? "Request change" : "Edit"}
                </button>
              )}
            </div>
          );
        })}
      </dl>

      {editField && (
        <div className="mt-4 border-t border-slate-100 pt-3 flex gap-2 items-center">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1"
          />
          <button
            disabled={submitting}
            onClick={() => submit(editField)}
            className="bg-brand-600 text-white text-sm px-3 py-1 rounded-md disabled:opacity-50"
          >
            {isHr ? "Save" : LOCKED_FIELDS.includes(editField) ? "Submit request" : "Save"}
          </button>
          <button
            onClick={() => setEditField(null)}
            className="text-sm text-slate-500 px-2"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const ROLE_OPTIONS = [Role.STAFF, Role.HOD, Role.HR_ADMIN];

function RoleAccessSection({
  targetId,
  currentRole,
  currentDepartmentId,
  currentCanSupervise,
  currentCategory,
  isSelf,
  onChanged,
}: {
  targetId: string;
  currentRole: string;
  currentDepartmentId: string;
  currentCanSupervise: boolean;
  currentCategory: string;
  isSelf: boolean;
  onChanged: (msg: string) => void;
}) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [role, setRole] = useState(currentRole);
  const [departmentId, setDepartmentId] = useState(currentDepartmentId);
  const [canSupervise, setCanSupervise] = useState(currentCanSupervise);
  const [category, setCategory] = useState(currentCategory);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    staffApi.departments().then(setDepartments).catch(() => setDepartments([]));
  }, []);

  const dirty =
    role !== currentRole ||
    departmentId !== currentDepartmentId ||
    canSupervise !== currentCanSupervise ||
    category !== currentCategory;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await staffApi.adminUpdate(targetId, { role, departmentId, canSupervise, category });
      onChanged("Access updated. If this changes what they can see, their next request will require signing in again.");
    } catch (e) {
      setError((e as Error).message || "Failed to update access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-1">Role &amp; Access</h2>
      <p className="text-xs text-slate-400 mb-3">
        Controls what this account can see and do — Staff (own records only), HOD (department
        approvals), or HR/Admin (full access, including payroll).
      </p>

      {isSelf ? (
        <p className="text-sm text-amber-600">
          You can&apos;t change your own role or department here — ask another HR/Admin to do it,
          so you don&apos;t accidentally lock yourself out.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col text-xs">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            Department
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            Holiday group
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
            >
              <option value="TEACHING">Teacher</option>
              <option value="NON_TEACHING">Admin Staff</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs pb-1.5">
            <input type="checkbox" checked={canSupervise} onChange={(e) => setCanSupervise(e.target.checked)} />
            Can assign overtime tasks (Supervisor)
          </label>
          <button
            disabled={!dirty || saving}
            onClick={save}
            className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save access"}
          </button>
        </div>
      )}
      {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
    </div>
  );
}

function BankDetailsSection({ targetId, onChanged }: { targetId: string; onChanged: (m: string) => void }) {
  const [bank, setBank] = useState<BankDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<BankDetail>({ bankName: "", accountNumber: "", salaryGrade: "" });

  useEffect(() => {
    staffApi.getBankDetails(targetId).then((b) => {
      setBank(b);
      if (b) setForm(b);
    });
  }, [targetId]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-slate-700 mb-1">Bank &amp; payroll (HR/Admin only)</h2>
        <button className="text-xs text-brand-600 hover:underline" onClick={() => setEditing((e) => !e)}>
          {editing ? "Cancel" : bank ? "Edit" : "Add"}
        </button>
      </div>
      {!editing && bank && (
        <dl className="grid grid-cols-3 gap-3 text-sm mt-2">
          <div><dt className="text-slate-400">Bank</dt><dd>{bank.bankName}</dd></div>
          <div><dt className="text-slate-400">Account number</dt><dd>{bank.accountNumber}</dd></div>
          <div><dt className="text-slate-400">Salary grade</dt><dd>{bank.salaryGrade}</dd></div>
          <div><dt className="text-slate-400">Basic salary</dt><dd>{bank.basicSalary ?? "—"}</dd></div>
          <div><dt className="text-slate-400">Service allowance</dt><dd>{bank.serviceAllowance ?? "—"}</dd></div>
          <div><dt className="text-slate-400">Job allowance</dt><dd>{bank.jobAllowance ?? "—"}</dd></div>
        </dl>
      )}
      {!editing && !bank && <p className="text-slate-400 text-sm mt-2">No bank details on file.</p>}
      {editing && (
        <div className="mt-3 space-y-2">
          {(["bankName", "accountNumber", "salaryGrade"] as const).map((f) => (
            <input
              key={f}
              placeholder={f}
              value={form[f]}
              onChange={(e) => setForm({ ...form, [f]: e.target.value })}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            />
          ))}
          <p className="text-xs text-slate-400 pt-1">Monthly payroll figures (used to generate salary slips):</p>
          {(["basicSalary", "serviceAllowance", "jobAllowance"] as const).map((f) => (
            <input
              key={f}
              type="number"
              min={0}
              step="0.01"
              placeholder={f}
              value={form[f] ?? ""}
              onChange={(e) => setForm({ ...form, [f]: e.target.value === "" ? null : Number(e.target.value) })}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            />
          ))}
          <button
            className="bg-brand-600 text-white text-sm px-3 py-1 rounded-md"
            onClick={async () => {
              // Omit payroll fields left blank rather than sending null (which
              // the server would coerce to 0 and treat as "configured").
              const payload = { ...form };
              (["basicSalary", "serviceAllowance", "jobAllowance"] as const).forEach((f) => {
                if (payload[f] == null) delete payload[f];
              });
              const updated = await staffApi.upsertBankDetails(targetId, payload);
              setBank(updated);
              setEditing(false);
              onChanged("Bank details saved.");
            }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function StatusSection({
  targetId,
  currentStatus,
  onChanged,
}: {
  targetId: string;
  currentStatus: string;
  onChanged: (m: string) => void;
}) {
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [newStatus, setNewStatus] = useState(currentStatus);
  const [reason, setReason] = useState("");

  useEffect(() => {
    staffApi.statusHistory(targetId).then(setHistory);
  }, [targetId]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Status</h2>
      <div className="flex gap-2 items-center mb-3">
        <select
          value={newStatus}
          onChange={(e) => setNewStatus(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1 text-sm"
        >
          {["ACTIVE", "ON_LEAVE", "SUSPENDED", "RESIGNED", "TERMINATED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          placeholder="reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1"
        />
        <button
          className="bg-slate-800 text-white text-sm px-3 py-1 rounded-md"
          onClick={async () => {
            await staffApi.changeStatus(targetId, newStatus, reason);
            onChanged("Status updated.");
            setHistory(await staffApi.statusHistory(targetId));
          }}
        >
          Update
        </button>
      </div>
      <ul className="text-xs text-slate-500 space-y-1">
        {history.map((h) => (
          <li key={h.id}>
            {new Date(h.changedAt).toLocaleString()} — {h.oldStatus ?? "—"} → {h.newStatus}
            {h.reason ? ` (${h.reason})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function QualificationsSection({ targetId, canEdit }: { targetId: string; canEdit: boolean }) {
  const [items, setItems] = useState<Qualification[]>([]);
  const [form, setForm] = useState({ type: "", institution: "", year: "" });

  useEffect(() => {
    staffApi.qualifications(targetId).then(setItems);
  }, [targetId]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Qualifications</h2>
      <ul className="text-sm space-y-1 mb-3">
        {items.map((q) => (
          <li key={q.id}>{q.type} — {q.institution}{q.year ? ` (${q.year})` : ""}</li>
        ))}
        {items.length === 0 && <li className="text-slate-400">None on file.</li>}
      </ul>
      {canEdit && (
        <div className="flex gap-2">
          <input placeholder="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Institution" value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Year" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm w-20" />
          <button
            className="bg-brand-600 text-white text-sm px-3 py-1 rounded-md"
            onClick={async () => {
              await staffApi.addQualification(targetId, {
                type: form.type,
                institution: form.institution,
                year: form.year ? Number(form.year) : undefined,
              });
              setForm({ type: "", institution: "", year: "" });
              setItems(await staffApi.qualifications(targetId));
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function DocumentsSection({ targetId, canEdit, isHr }: { targetId: string; canEdit: boolean; isHr: boolean }) {
  const [docs, setDocs] = useState<{ id: string; docType: string; originalName: string }[]>([]);
  const [docType, setDocType] = useState("ID");

  async function refresh() {
    setDocs(await staffApi.documents(targetId));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Documents</h2>
      <ul className="text-sm space-y-1 mb-3">
        {docs.map((d) => (
          <li key={d.id}>{d.docType} — {d.originalName}</li>
        ))}
        {docs.length === 0 && <li className="text-slate-400">None uploaded.</li>}
      </ul>
      {canEdit && (
        <div className="flex gap-2 items-center">
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-sm">
            <option value="ID">ID</option>
            <option value="CONTRACT">Contract</option>
            <option value="CERTIFICATE">Certificate</option>
            {isHr && <option value="PHOTO">Photo</option>}
            <option value="OTHER">Other</option>
          </select>
          <input
            type="file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await uploadStaffDocument(targetId, file, docType);
              await refresh();
            }}
            className="text-sm"
          />
        </div>
      )}
    </div>
  );
}
