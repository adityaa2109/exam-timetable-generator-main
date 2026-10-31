// Data management: every button calls an engine command, then re-reads the
// engine's state, so the tables always show what the engine really holds.
import { h, icon, button, badge, fmt, emptyState, sectionHeader, toast, confirmDialog, draft, keepDraft, clearDrafts } from "../ui.js";
import { engine, store, act, isBusy, mutate, loadSample, notify, refresh } from "../store.js";

const TABS = [
  { id: "quick", label: "Quick entry" },
  { id: "subjects", label: "Subjects" },
  { id: "batches", label: "Batches" },
  { id: "slots", label: "Time slots" },
  { id: "samples", label: "Import & samples" },
];
let tab = "quick";
let picked = new Set();     // subject ids chosen for a new batch
const SESSION_TIMES = ["09:00 AM", "02:00 PM", "05:30 PM"];

const noPipe = (value, what) => (value.includes("|") ? `${what} cannot contain the "|" character.` : null);

export function render(root) {
  const state = store.state;
  if (!state) return;
  root.append(
    h("header", { class: "page-head" },
      h("div", {},
        h("h2", { class: "page-title" }, "Data"),
        h("p", { class: "lede" }, "Enter your own subjects, student batches and time slots — one at a time or in bulk. Every change is applied by the engine and the conflict graph is rebuilt automatically."),
      ),
      h("div", { class: "head-actions" },
        button("Import", { iconName: "upload", busy: isBusy("import"), onClick: importFile, title: "Load a Slotwise / CLI data file" }),
        button("Export", { iconName: "download", busy: isBusy("export"), onClick: exportFile, disabled: store.state.subjects.length === 0 && store.state.slots.length === 0 }),
        button("Clear all", { variant: "danger-ghost", iconName: "trash", busy: isBusy("clear"), onClick: clearAll,
          disabled: state.subjects.length === 0 && state.batches.length === 0 && state.slots.length === 0 }),
      ),
    ),
  );

  const counts = { subjects: state.subjects.length, batches: state.batches.length, slots: state.slots.length };
  const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Data sections" },
    TABS.map((t) => h("button", {
      type: "button", role: "tab", id: `tab-${t.id}`, class: `tab${tab === t.id ? " on" : ""}`,
      "aria-selected": String(tab === t.id), "aria-controls": `panel-${t.id}`, tabindex: tab === t.id ? "0" : "-1",
      onclick: () => { tab = t.id; notify(); },
    }, t.label, counts[t.id] !== undefined ? h("span", { class: "count" }, counts[t.id]) : null)));
  tablist.addEventListener("keydown", (event) => {
    const index = TABS.findIndex((t) => t.id === tab);
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    tab = next.id;
    notify();
    requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
  });

  const panel = h("div", { class: "tab-panel", role: "tabpanel", id: `panel-${tab}`, "aria-labelledby": `tab-${tab}` });
  ({ quick: quickPanel, subjects: subjectsPanel, batches: batchesPanel, slots: slotsPanel, samples: samplesPanel })[tab](panel);
  root.append(tablist, panel);
}

// ---- quick entry (bulk manual entry) ----------------------------------------------
const QUICK_EXAMPLE = {
  slots: "Day 1 - 09:00 AM\nDay 1 - 02:00 PM\nDay 2 - 09:00 AM\nDay 2 - 02:00 PM",
  batches: "CSE Year 1 | 60 | CS101, MA101, PH101\nCSE Year 2 | 55 | CS201, MA201, CS101\nECE Year 1 | 48 | EC101, MA101, PH101",
  subjects: "CS101 | Programming Fundamentals\nMA101 | Calculus\nPH101 | Physics",
};

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

// Turns the three text boxes into a plan and a list of problems. Nothing is sent
// to the engine here; the engine still validates every record when it is added.
function parseQuick(slotText, batchText, subjectText) {
  const problems = [];
  const slots = [];
  const subjects = new Map();   // CODE -> { code, name, students, explicit }
  const batches = [];

  lines(slotText).forEach((label, i) => {
    if (label.includes("|")) problems.push(`Time slot line ${i + 1}: "|" is not allowed.`);
    else if (slots.some((s) => s.toLowerCase() === label.toLowerCase())) problems.push(`Time slot "${label}" is listed twice.`);
    else slots.push(label);
  });

  lines(subjectText).forEach((line, i) => {
    const [code = "", name = "", count = ""] = line.split("|").map((p) => p.trim());
    const students = count === "" ? 0 : Number(count);
    if (!code) return problems.push(`Subject line ${i + 1}: the code is missing.`);
    if (!Number.isInteger(students) || students < 0) return problems.push(`Subject ${code}: students must be a whole number (or empty).`);
    const key = code.toUpperCase();
    if (subjects.has(key)) return problems.push(`Subject ${key} is listed twice.`);
    subjects.set(key, { code, name: name || code, students, explicit: true });
  });

  lines(batchText).forEach((line, i) => {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3) return problems.push(`Batch line ${i + 1}: use  Name | students | CODE, CODE, ...`);
    const [name, count, list] = parts;
    const students = Number(count);
    const codes = [...new Set(list.split(/[\s,;]+/).filter(Boolean).map((c) => c.toUpperCase()))];
    if (!name) return problems.push(`Batch line ${i + 1}: the batch name is missing.`);
    if (!Number.isInteger(students) || students < 1) return problems.push(`Batch "${name}": students must be a whole number of at least 1.`);
    if (codes.length === 0) return problems.push(`Batch "${name}": list at least one subject code.`);
    if (batches.some((b) => b.name.toLowerCase() === name.toLowerCase())) return problems.push(`Batch "${name}" is listed twice.`);
    for (const code of codes) if (!subjects.has(code)) subjects.set(code, { code, name: code, students: 0, explicit: false });
    batches.push({ name, students, codes });
  });

  return { problems, slots, batches, subjects: [...subjects.values()] };
}

function quickPanel(panel) {
  const state = store.state;
  const slotBox = keepDraft(h("textarea", { id: "q-slots", class: "input textarea", rows: 5, spellcheck: "false", placeholder: QUICK_EXAMPLE.slots }, draft("q-slots")));
  const batchBox = keepDraft(h("textarea", { id: "q-batches", class: "input textarea", rows: 6, spellcheck: "false", placeholder: QUICK_EXAMPLE.batches }, draft("q-batches")));
  const subjectBox = keepDraft(h("textarea", { id: "q-subjects", class: "input textarea", rows: 4, spellcheck: "false", placeholder: QUICK_EXAMPLE.subjects }, draft("q-subjects")));
  const days = keepDraft(h("input", { id: "q-days", class: "input input-sm", type: "number", min: 1, max: 30, value: draft("q-days", "3") }));
  const sessions = keepDraft(h("select", { id: "q-sessions", class: "input input-sm" },
    [1, 2, 3].map((n) => h("option", { value: n, selected: String(n) === String(draft("q-sessions", "2")) }, `${n} per day`))));
  const replace = keepDraft(h("input", { id: "q-replace", type: "checkbox", checked: draft("q-replace", false) === true }));
  const preview = h("div", { class: "quick-preview", "aria-live": "polite" });

  const update = () => {
    const plan = parseQuick(slotBox.value, batchBox.value, subjectBox.value);
    const bits = [fmt.plural(plan.slots.length, "time slot"), fmt.plural(plan.batches.length, "batch", "batches"), fmt.plural(plan.subjects.length, "subject")];
    const fromBatches = plan.subjects.filter((s) => !s.explicit).length;
    preview.replaceChildren(...[
      h("p", { class: "muted small" }, `Ready to add: ${bits.join(" · ")}${fromBatches ? ` (${fromBatches} subject${fromBatches === 1 ? "" : "s"} created from batch lists)` : ""}.`),
      plan.problems.length ? h("ul", { class: "quick-problems" }, plan.problems.slice(0, 8).map((p) => h("li", {}, p))) : null,
      plan.problems.length > 8 ? h("p", { class: "muted small" }, `…and ${plan.problems.length - 8} more.`) : null,
    ].filter(Boolean));
    return plan;
  };
  [slotBox, batchBox, subjectBox].forEach((box) => box.addEventListener("input", update));

  const fillSlots = () => {
    const d = Number(days.value);
    const s = Number(sessions.value);
    if (!Number.isInteger(d) || d < 1 || d > 30) return toast("Days must be a whole number from 1 to 30.", "error");
    const out = [];
    for (let day = 1; day <= d; day++) for (let i = 0; i < s; i++) out.push(`Day ${day} - ${SESSION_TIMES[i]}`);
    slotBox.value = out.join("\n");
    syncDraft(slotBox);
    update();
  };

  const submit = async (build) => {
    const plan = update();
    if (plan.problems.length) return toast("Fix the highlighted problems first.", "error");
    if (plan.batches.length === 0 && plan.subjects.length === 0 && plan.slots.length === 0) return toast("Nothing to add yet — fill in at least one box.", "error");
    if (replace.checked && (state.subjects.length || state.batches.length || state.slots.length)) {
      const ok = await confirmDialog({ title: "Replace existing data?", body: "Every current subject, batch and time slot is removed before your new entries are added.", confirmLabel: "Replace data", danger: true });
      if (!ok) return;
    }
    const outcome = await act("quick-add", async () => {
      const failures = [];
      if (replace.checked) await engine.call("clear");
      await refresh();
      const idByCode = new Map(store.state.subjects.map((s) => [s.code.toUpperCase(), s.id]));
      let added = { slots: 0, subjects: 0, batches: 0 };
      for (const label of plan.slots) {
        try { await engine.call("slot.add", label); added.slots++; } catch (e) { failures.push(`Slot "${label}": ${e.message}`); }
      }
      for (const s of plan.subjects) {
        if (idByCode.has(s.code.toUpperCase())) continue;   // already in the engine: reuse it
        try { const r = await engine.call("subject.add", `${s.code}|${s.name}|${s.students}`); idByCode.set(s.code.toUpperCase(), r.id); added.subjects++; }
        catch (e) { failures.push(`Subject ${s.code}: ${e.message}`); }
      }
      for (const b of plan.batches) {
        const ids = b.codes.map((c) => idByCode.get(c)).filter((id) => id !== undefined);
        if (ids.length !== b.codes.length) { failures.push(`Batch "${b.name}": some subjects could not be created.`); continue; }
        try { await engine.call("batch.add", `${b.name}|${b.students}|${ids.join(",")}`); added.batches++; } catch (e) { failures.push(`Batch "${b.name}": ${e.message}`); }
      }
      await refresh();
      if (build && failures.length === 0 && store.state.subjects.length) {
        await engine.call("run", "bnb");
        await refresh();
      }
      return { added, failures };
    });
    if (!outcome) return;
    const { added, failures } = outcome;
    if (failures.length) {
      toast(`Added ${added.subjects} subjects, ${added.batches} batches, ${added.slots} slots — ${failures.length} problem${failures.length === 1 ? "" : "s"}: ${failures[0]}`, "error");
      return;   // keep the text so the user can correct it (already-added items are skipped on retry)
    }
    clearDrafts("q-slots", "q-batches", "q-subjects", "q-replace");
    toast(`Added ${fmt.plural(added.subjects, "subject")}, ${fmt.plural(added.batches, "batch", "batches")} and ${fmt.plural(added.slots, "slot")}.`, "success");
    if (build) location.hash = "#/timetable"; else notify();
  };

  panel.append(
    h("form", { class: "card", "aria-label": "Quick entry", onsubmit: (e) => { e.preventDefault(); submit(false); } },
      h("div", {},
        h("h3", { class: "card-title" }, "Enter your exam data"),
        h("p", { class: "muted small" }, "One line per record. Subjects named in a batch are created automatically, so the batch box alone is enough to get a timetable. Lines starting with # are ignored."),
      ),
      h("div", { class: "quick-step" },
        field("1 · Time slots — one label per line", slotBox),
        h("div", { class: "form-row bare quick-fill" },
          h("span", { class: "muted small" }, "or generate:"),
          h("label", { class: "inline-field", for: "q-days" }, days, "days"),
          sessions,
          button("Fill slots", { size: "sm", onClick: fillSlots })),
      ),
      h("div", { class: "quick-step" },
        field("2 · Student batches — Name | students | subject codes", batchBox),
        h("p", { class: "muted small" }, "Every pair of subjects in one batch becomes a clash: those exams can never share a slot."),
      ),
      h("div", { class: "quick-step" },
        field("3 · Subject names (optional) — CODE | Name | students", subjectBox),
        h("p", { class: "muted small" }, "Only needed if you want full names. Leave the student count empty to derive it from batches."),
      ),
      state.subjects.length || state.batches.length || state.slots.length
        ? h("label", { class: "check", for: "q-replace" }, replace, `Replace the ${state.subjects.length} subjects, ${state.batches.length} batches and ${state.slots.length} slots already entered (otherwise new entries are added to them)`)
        : null,
      preview,
      h("div", { class: "form-actions" },
        button("Add to engine", { type: "submit", variant: "primary", iconName: "plus", busy: isBusy("quick-add") }),
        button("Add and build optimal timetable", { iconName: "target", busy: isBusy("quick-add"), onClick: () => submit(true) }),
        button("Use example", { variant: "ghost", onClick: () => { slotBox.value = QUICK_EXAMPLE.slots; batchBox.value = QUICK_EXAMPLE.batches; subjectBox.value = QUICK_EXAMPLE.subjects; [slotBox, batchBox, subjectBox].forEach(syncDraft); update(); } })),
    ),
  );
  update();
}

function syncDraft(box) { box.dispatchEvent(new Event("input")); }

// ---- subjects -------------------------------------------------------------------
function subjectsPanel(panel) {
  const state = store.state;
  const code = keepDraft(h("input", { id: "f-code", class: "input", placeholder: "CS101", value: draft("f-code"), maxlength: 16, required: true }));
  const name = keepDraft(h("input", { id: "f-name", class: "input", placeholder: "Data Structures", value: draft("f-name"), maxlength: 60, required: true }));
  const students = keepDraft(h("input", { id: "f-students", class: "input", type: "number", min: 0, placeholder: "Auto", value: draft("f-students") }));

  const submit = async (event) => {
    event.preventDefault();
    const c = code.value.trim();
    const n = name.value.trim();
    const count = students.value.trim() === "" ? 0 : Number(students.value);
    const problem = (!c || !n) ? "Code and name are required." : noPipe(c, "Code") || noPipe(n, "Name")
      || (!Number.isInteger(count) || count < 0 ? "Students must be a whole number (leave empty to derive from batches)." : null);
    if (problem) return toast(problem, "error");
    const response = await act("add-subject", () => mutate("subject.add", `${c}|${n}|${count}`));
    if (response) {
      clearDrafts("f-code", "f-name", "f-students");
      toast(`Added ${c.toUpperCase()}.`, "success");
      notify();
      requestAnimationFrame(() => document.getElementById("f-code")?.focus());
    }
  };

  panel.append(
    h("form", { class: "card form-row", onsubmit: submit, "aria-label": "Add subject" },
      field("Code", code), field("Name", name, "grow"), field("Students", students),
      button("Add subject", { type: "submit", variant: "primary", iconName: "plus", busy: isBusy("add-subject") })),
  );
  if (state.subjects.length === 0) {
    panel.append(h("div", { class: "card" }, emptyState({ iconName: "database", title: "No subjects", body: "Add a subject above, or use Quick entry to add many at once." })));
    return;
  }
  panel.append(h("div", { class: "card flush" }, h("div", { class: "table-wrap" },
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Code"), h("th", {}, "Name"), h("th", { class: "num" }, "Students"),
        h("th", { class: "num" }, "Batches"), h("th", { class: "num" }, "Conflicts"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
      h("tbody", {}, state.subjects.map((s) => h("tr", {},
        h("td", {}, h("code", {}, s.code)),
        h("td", {}, s.name),
        h("td", { class: "num" }, fmt.int(s.students), s.derived ? h("span", { class: "muted", title: "Derived from batch sizes" }, " *") : null),
        h("td", { class: "num" }, s.batches.length),
        h("td", { class: "num" }, s.degree),
        h("td", { class: "num" }, iconButton("trash", `Remove ${s.code}`, () => removeSubject(s)))))))),
    h("p", { class: "muted small pad" }, "* derived from the sizes of the batches that take the subject.")));
}

async function removeSubject(subject) {
  const inBatches = subject.batches.length;
  const ok = await confirmDialog({
    title: `Remove ${subject.code}?`,
    body: inBatches
      ? `${subject.code} is taken by ${fmt.plural(inBatches, "batch", "batches")}. It will be removed from ${inBatches === 1 ? "it" : "them"} and the conflict graph rebuilt.`
      : "The subject has no batches, so no conflicts change.",
    confirmLabel: "Remove subject", danger: true,
  });
  if (ok && await act(`rm-s-${subject.id}`, () => mutate("subject.remove", String(subject.id)))) toast(`Removed ${subject.code}.`, "success");
}

// ---- batches --------------------------------------------------------------------
function batchesPanel(panel) {
  const state = store.state;
  const name = keepDraft(h("input", { id: "f-bname", class: "input", placeholder: "CSE Year 1", value: draft("f-bname"), maxlength: 40 }));
  const students = keepDraft(h("input", { id: "f-bstudents", class: "input", type: "number", min: 1, placeholder: "60", value: draft("f-bstudents") }));
  picked = new Set([...picked].filter((id) => state.subjects.some((s) => s.id === id)));

  const submit = async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    const count = Number(students.value);
    const problem = !n ? "Batch name is required." : noPipe(n, "Name")
      || (!Number.isInteger(count) || count < 1 ? "Students must be a whole number of at least 1." : null);
    if (problem) return toast(problem, "error");
    const ids = [...picked];
    const response = await act("add-batch", () => mutate("batch.add", `${n}|${count}|${ids.join(",")}`));
    if (response) {
      clearDrafts("f-bname", "f-bstudents");
      picked = new Set();
      toast(ids.length < 2 ? `Added ${n}. With fewer than two subjects it creates no conflicts.` : `Added ${n}.`, "success");
      notify();
    }
  };

  if (state.subjects.length === 0) {
    panel.append(h("div", { class: "card" }, emptyState({ iconName: "database", title: "Add subjects first", body: "A batch is a group of students who sit the same set of subjects." })));
  } else {
    panel.append(
      h("form", { class: "card", onsubmit: submit, "aria-label": "Add batch" },
        h("div", { class: "form-row bare" }, field("Batch name", name, "grow"), field("Students", students)),
        h("fieldset", { class: "picker" },
          h("legend", {}, `Subjects taken (${picked.size} selected) — every pair becomes a conflict`),
          h("div", { class: "picker-chips" }, state.subjects.map((s) => {
            const id = `pick-${s.id}`;
            return h("label", { class: `pick${picked.has(s.id) ? " on" : ""}`, for: id },
              h("input", { type: "checkbox", id, checked: picked.has(s.id), onchange: (e) => { if (e.target.checked) picked.add(s.id); else picked.delete(s.id); notify(); } }),
              h("code", {}, s.code));
          }))),
        h("div", { class: "form-actions" }, button("Add batch", { type: "submit", variant: "primary", iconName: "plus", busy: isBusy("add-batch") })),
      ),
    );
  }
  if (state.batches.length === 0) return;
  const codeOf = (id) => (state.subjects.find((s) => s.id === id) || {}).code || `#${id}`;
  panel.append(h("div", { class: "card flush" }, h("div", { class: "table-wrap" },
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Batch"), h("th", { class: "num" }, "Students"), h("th", {}, "Subjects"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
      h("tbody", {}, state.batches.map((b) => h("tr", {},
        h("td", {}, b.name),
        h("td", { class: "num" }, fmt.int(b.students)),
        h("td", {}, h("div", { class: "code-list" }, b.subjects.length ? b.subjects.map((id) => h("code", {}, codeOf(id))) : h("span", { class: "muted" }, "none"))),
        h("td", { class: "num" }, iconButton("trash", `Remove ${b.name}`, async () => {
          const ok = await confirmDialog({ title: `Remove ${b.name}?`, body: "Conflicts caused only by this batch disappear from the graph.", confirmLabel: "Remove batch", danger: true });
          if (ok && await act(`rm-b-${b.id}`, () => mutate("batch.remove", String(b.id)))) toast(`Removed ${b.name}.`, "success");
        })))))))));
}

// ---- slots ------------------------------------------------------------------------
function slotsPanel(panel) {
  const state = store.state;
  const label = keepDraft(h("input", { id: "f-slot", class: "input", placeholder: "Day 1 - 09:00 AM", value: draft("f-slot"), maxlength: 40 }));
  const days = keepDraft(h("input", { id: "f-days", class: "input", type: "number", min: 1, max: 30, value: draft("f-days", "3") }));
  const sessions = keepDraft(h("select", { id: "f-sessions", class: "input" },
    [1, 2, 3].map((n) => h("option", { value: n, selected: String(n) === String(draft("f-sessions", "2")) }, `${n} per day`))));

  const addOne = async (event) => {
    event.preventDefault();
    const text = label.value.trim();
    const problem = !text ? "Slot label is required." : noPipe(text, "Label");
    if (problem) return toast(problem, "error");
    if (await act("add-slot", () => mutate("slot.add", text))) {
      clearDrafts("f-slot");
      toast(`Added slot "${text}".`, "success");
      notify();
    }
  };
  const quickAdd = async (event) => {
    event.preventDefault();
    const d = Number(days.value);
    const s = Number(sessions.value);
    if (!Number.isInteger(d) || d < 1 || d > 30) return toast("Days must be a whole number from 1 to 30.", "error");
    await act("quick-slots", async () => {
      let added = 0;
      const skipped = [];
      for (let day = 1; day <= d; day++) {
        for (let i = 0; i < s; i++) {
          const text = `Day ${day} - ${SESSION_TIMES[i]}`;
          try {
            await engine.call("slot.add", text);
            added++;
          } catch (error) {
            skipped.push(error.message);
          }
        }
      }
      await refresh();
      toast(`Added ${fmt.plural(added, "slot")}${skipped.length ? `, skipped ${skipped.length} (already exist)` : ""}.`, added ? "success" : "info");
    });
  };

  panel.append(
    h("div", { class: "grid-2" },
      h("form", { class: "card form-row", onsubmit: addOne, "aria-label": "Add one slot" },
        field("Slot label", label, "grow"),
        button("Add slot", { type: "submit", variant: "primary", iconName: "plus", busy: isBusy("add-slot") })),
      h("form", { class: "card form-row", onsubmit: quickAdd, "aria-label": "Quick-add slots" },
        field("Exam days", days), field("Sessions", sessions),
        button("Quick-add", { type: "submit", iconName: "plus", busy: isBusy("quick-slots") })),
    ),
  );
  if (state.slots.length === 0) {
    panel.append(h("div", { class: "card" }, emptyState({ iconName: "calendar", title: "No time slots", body: "The engine only places exams into slots marked available. Add some above." })));
    return;
  }
  const available = state.slots.filter((s) => s.available).length;
  panel.append(h("div", { class: "card flush" },
    h("p", { class: "muted small pad" }, `${available} of ${state.slots.length} slots available. Colour c of a timetable goes into the c-th available slot, in this order.`),
    h("ul", { class: "slot-rows" }, state.slots.map((slot) => {
      const id = `avail-${slot.id}`;
      return h("li", { class: slot.available ? "" : "off" },
        h("span", { class: "slot-row-label" }, slot.label),
        slot.available ? badge("Available", "good") : badge("Disabled", "neutral"),
        h("label", { class: "switch", for: id, title: slot.available ? "Disable slot" : "Enable slot" },
          h("input", { type: "checkbox", role: "switch", id, checked: slot.available,
            disabled: isBusy(`slot-${slot.id}`),
            onchange: (e) => act(`slot-${slot.id}`, () => mutate("slot.set", `${slot.id}|${e.target.checked ? 1 : 0}`)) }),
          h("span", { class: "switch-track", "aria-hidden": "true" }),
          h("span", { class: "sr-only" }, `${slot.label} available`)),
        iconButton("trash", `Remove ${slot.label}`, () => act(`rm-t-${slot.id}`, () => mutate("slot.remove", String(slot.id)))));
    }))));
}

// ---- samples & files ----------------------------------------------------------------
function samplesPanel(panel) {
  const sample = (letter, title, body, tags) => h("article", { class: "sample-card" },
    h("div", { class: "sample-letter", "aria-hidden": "true" }, letter),
    h("div", { class: "sample-body" },
      h("h3", {}, title), h("p", {}, body), h("div", { class: "badges" }, tags.map((t) => badge(t, "neutral")))),
    button("Load", { variant: letter === "B" ? "primary" : "secondary", busy: isBusy(`sample-${letter}`), onClick: () => confirmLoad(letter) }));

  panel.append(
    h("p", { class: "muted small" }, "Sample datasets are optional demos for exploring the algorithms. Loading one replaces whatever you have entered — your own data never needs them."),
    h("div", { class: "samples" },
      sample("A", "Small college", "CS101, MA101, PH101, EN101, EE101, CS102 across four first- and second-year batches.", ["6 subjects", "4 batches", "6 slots", "needs 3"]),
      sample("B", "Crown graph — the greedy trap", "Ai clashes with Bj when i ≠ j. Input-order greedy is forced into 3 slots; the optimum is 2.", ["6 subjects", "6 batches", "4 slots", "greedy 3 · optimal 2"]),
      sample("C", "Stress test", "30 electives with 45 seeded random batches — plain backtracking hits its limit while branch and bound proves 9.", ["30 subjects", "45 batches", "9 slots"]),
    ),
    h("section", { class: "card" },
      sectionHeader("Files", "Plain-text format shared with the terminal build (SUBJECT|…, BATCH|…, SLOT|… lines).",
        button("Import file", { iconName: "upload", busy: isBusy("import"), onClick: importFile }),
        button("Export file", { iconName: "download", busy: isBusy("export"), onClick: exportFile })),
      h("p", { class: "muted small" }, "Import replaces the current data only if the whole file is valid — the engine checks it first."),
    ),
  );
}

async function confirmLoad(letter) {
  const state = store.state;
  if (state.subjects.length || state.slots.length) {
    const ok = await confirmDialog({ title: `Load Sample ${letter}?`, body: "This replaces the current subjects, batches and slots.", confirmLabel: "Replace data" });
    if (!ok) return;
  }
  if (await act(`sample-${letter}`, () => loadSample(letter))) toast(`Sample ${letter} loaded.`, "success");
}

// ---- import / export / clear -----------------------------------------------------------
function importFile() {
  const picker = h("input", { type: "file", accept: ".txt,.csv,text/plain" });
  picker.addEventListener("change", async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast("That file is larger than 2 MB.", "error");
    const text = await file.text();
    const ok = await act("import", async () => {
      await engine.writeFile("/tmp/slotwise-import.txt", text);
      await mutate("load", "/tmp/slotwise-import.txt");
      return true;
    });
    if (ok) {
      store.sample = null;
      toast(`Imported ${file.name}.`, "success");
      notify();
    }
  });
  picker.click();
}

async function exportFile() {
  const text = await act("export", async () => {
    await engine.call("save", "/tmp/slotwise-export.txt");
    return engine.readFile("/tmp/slotwise-export.txt");
  });
  if (typeof text !== "string") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = h("a", { href: url, download: "slotwise-data.txt" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Exported slotwise-data.txt.", "success");
}

async function clearAll() {
  const ok = await confirmDialog({ title: "Clear all data?", body: "Removes every subject, batch and time slot from the engine. This cannot be undone (export first if you need a copy).", confirmLabel: "Clear everything", danger: true });
  if (ok && await act("clear", () => mutate("clear"))) {
    store.sample = null;
    toast("All data cleared.", "success");
    notify();
  }
}

// ---- helpers ---------------------------------------------------------------------------
function field(label, control, extra = "") {
  return h("label", { class: `field ${extra}`, for: control.id }, h("span", {}, label), control);
}

function iconButton(name, label, onClick) {
  return h("button", { type: "button", class: "icon-btn danger", "aria-label": label, title: label, onclick: onClick }, icon(name));
}
