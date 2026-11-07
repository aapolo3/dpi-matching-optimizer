/**
 * DPI Matching Optimizer — auth, host + student application persistence,
 * admin roster, and compiled Excel export.
 *
 * Every application document is owned by the Google account that created it
 * (`ownerUid`); Firestore rules keep hosts and students scoped to their own
 * record while admins can read the full roster.
 *
 * Document shapes (mostly app-enforced; firestore.rules is the contract for
 * ownership, admin fields, text caps, and createdAt):
 *   users/{uid}     role: student | host | admin
 *                   Admin is a manual Firestore edit — owners cannot self-promote.
 *   catalog/{id}    public subset of a project, same id. Students rank from it.
 *   projects/{id}   status: draft | submitted
 *                   reviewStatus: submitted | approved | changes_requested | archived
 *                   assignedInterns[] is written only by assignStudentToProject.
 *   students/{id}   status: draft | submitted
 *                   reviewStatus: waitlisted | submitted | denied | reviewing | matched
 *                   matchedProject / matchedProjectId written only by assignStudentToProject.
 *
 * Views are toggled by showView() — there is no URL router.
 * See docs/website.md for the full handoff.
 */

(function () {
  const VIEW_IDS = [
    "landing",
    "admin",
    "admin-project",
    "apply-1",
    "apply-2",
    "apply-3",
    "apply-4",
    "host",
  ];

  /**
   * Application `status` stays draft|submitted for the student/host forms.
   * Admin boards use a separate `reviewStatus`:
   *   students → waitlisted | submitted | denied | reviewing | matched
   *   projects → submitted | approved | changes_requested | archived
   * Newly submitted apps default reviewStatus to "submitted".
   */
  const STUDENT_BOARD_STATUSES = [
    "waitlisted",
    "submitted",
    "denied",
    "reviewing",
    "matched",
  ];
  const PROJECT_REVIEW_STATUSES = [
    "submitted",
    "approved",
    "changes_requested",
    "archived",
  ];

  const HOST_TEXT_FIELDS = [
    "supervisorName",
    "supervisorEmail",
    "workLocations",
    "innovationCenter",
    "companyName",
    "projectTitle",
    "description",
    "internLogistics",
    "technicalSkills",
    "officeCulture",
    "notes",
    "companyWebsite",
  ];

  const HOST_CHOICE_DEFAULTS = {
    firstInterns: "No",
    hostDays: "3 Host days",
    expertiseSupport: "Yes",
    projectStructure: "Same project, as a team",
    interviewInvolvement: "Yes",
  };

  const STUDENT_CHOICE_DEFAULTS = {
    illinoisResident: "Yes",
    usCitizen: "Yes",
    projectLength: "Summer only",
    transportation: "Own vehicle",
    laptopAccess: "Yes",
    anyProjectFits: "No",
  };

  const STUDENT_MULTI_FIELDS = [
    "interests",
    "raceEthnicity",
    "courseworkHs",
    "courseworkCollege",
  ];
  const STUDENT_CHECK_MULTI_FIELDS = [];
  const STUDENT_ACK_FIELDS = [
    "ackCommitment",
    "ackOrientation",
    "ackAbsences",
    "ackProgramDates",
    "confirmSubmit",
  ];
  const STUDENT_RATED_SKILLS = [
    "Python",
    "SQL",
    "Excel",
    "Figma",
    "R",
    "Tableau",
  ];
  const INTEREST_LABELS = {
    Engineering: "Software engineering",
    Data: "Data & analytics",
    Design: "Product design",
    Marketing: "Marketing",
    Research: "Research",
  };
  const STUDENT_DOC_TYPES = ["resume", "transcript"];
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const LOGO_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ];
  const LOGO_EXT_RE = /\.(png|jpe?g|webp|pdf)$/i;

  const avatar = document.getElementById("user-avatar");
  const authStatus = document.getElementById("auth-status");
  const btnSignIn = document.getElementById("btn-sign-in");
  const btnSignOut = document.getElementById("btn-sign-out");
  const btnHostApp = document.getElementById("btn-host-app");
  const btnStudentApp = document.getElementById("btn-student-app");
  const btnAdminBoard = document.getElementById("btn-admin-board");
  const btnApplyHost = document.getElementById("btn-apply-host");
  const hostForm = document.getElementById("host-form");
  const hostStatus = document.getElementById("host-form-status");
  const hostUploadStatus = document.getElementById("host-upload-status");
  const btnSaveDraft = document.getElementById("btn-save-draft");
  const adminList = document.getElementById("admin-projects-list");
  const adminStudentsList = document.getElementById("admin-students-list");
  const adminMeta = document.getElementById("admin-projects-meta");
  const adminExportStatus = document.getElementById("admin-export-status");
  const btnExportStudents = document.getElementById("btn-export-students");
  const btnExportHosts = document.getElementById("btn-export-hosts");
  const btnRefreshAdmin = document.getElementById("btn-refresh-admin");
  const studentStatus = document.getElementById("student-form-status");
  const studentReviewStatus = document.getElementById("student-review-status");
  const btnStudentSaveDraft = document.getElementById("btn-student-save-draft");
  const btnStudentSubmit = document.getElementById("btn-student-submit");
  const studentChoicesEl = document.getElementById("student-project-choices");
  const studentChoicesMeta = document.getElementById("student-projects-meta");

  let currentView = "landing";
  let authUser = null;
  let userProfile = null;
  let pendingRole = "student";
  let hostProjectId = null;
  let hostProjectLoaded = false;
  let studentDocId = null;
  let studentDocLoaded = false;
  let projectCatalog = [];
  let projectCatalogLoaded = false;
  let studentChoices = [];
  let studentDocuments = {
    resume: null,
    transcript: null,
  };
  let hostLogo = null;
  let adminProjectsCache = [];
  let adminStudentsCache = [];
  let adminUnsubscribers = [];
  let adminReady = null;
  let adminRejectReady = null;
  let adminGeneration = 0;
  let adminBoardBound = false;
  let selectedAdminProjectId = null;
  let dragStudentId = null;

  const app = firebase.initializeApp(window.FIREBASE_CONFIG);
  // App Check stays dormant until appCheckSiteKey is set. It must activate
  // before the first Auth, Firestore or Storage call so every request is attested.
  const appCheckSiteKey = String(window.FIREBASE_CONFIG.appCheckSiteKey || "").trim();
  if (appCheckSiteKey && typeof firebase.appCheck === "function") {
    firebase.appCheck().activate(
      new firebase.appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey),
      true
    );
  }
  const auth = firebase.auth();
  const db = firebase.firestore();
  const storage = firebase.storage();

  // ---------------------------------------------------------------------------
  // Views — one <main class="view"> is visible at a time. No client router.
  // ---------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getViewEl(name) {
    return (
      document.getElementById("view-" + name) ||
      document.querySelector('[data-view="' + name + '"]')
    );
  }

  /**
   * Show one view and hide the rest. Re-toggles `.is-active` so CSS enter
   * animations replay. Opening admin starts Firestore listeners; leaving it
   * stops them so the board does not keep reading in the background.
   */
  function showView(name) {
    const next = getViewEl(name);
    if (!next) {
      console.error("[app] Unknown or missing view:", name);
      return;
    }
    if (name === currentView && next.classList.contains("is-active")) return;

    VIEW_IDS.forEach((key) => {
      const el = getViewEl(key);
      if (!el) return;
      el.classList.toggle("is-active", key === name);
    });

    next.classList.remove("is-active");
    void next.offsetWidth;
    next.classList.add("is-active");

    currentView = name;
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (name === "host" && authUser) {
      loadHostProject().catch((err) => setHostStatus(err.message, true));
    }
    if (name.startsWith("apply")) {
      clearStudentStatusForStep(name);
      onEnterApplyView(name);
    }
    if (
      (name === "admin" || name === "admin-project") &&
      userProfile &&
      userProfile.role === "admin"
    ) {
      startAdminListeners();
      if (name === "admin-project" && selectedAdminProjectId) {
        renderAdminProjectDetail(selectedAdminProjectId);
      }
    }
  }

  function initialsFrom(name, email) {
    const source = (name || email || "?").trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return source.slice(0, 2).toUpperCase();
  }

  function setStatusEl(el, message, isError) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function setHostStatus(message, isError) {
    setStatusEl(hostStatus, message, isError);
  }

  function setHostUploadStatus(message, isError) {
    setStatusEl(hostUploadStatus, message, isError);
  }

  function setStudentFormStatus(message, isError) {
    setStatusEl(studentStatus, message, isError);
  }

  function setStudentReviewStatus(message, isError) {
    setStatusEl(studentReviewStatus, message, isError);
  }

  function clearStudentStatusForStep(stepName) {
    if (stepName !== "apply-1") setStatusEl(studentStatus, "", false);
    if (stepName !== "apply-4") setStatusEl(studentReviewStatus, "", false);
  }

  function setStudentStatus(message, isError) {
    const onReview = currentView === "apply-4";
    if (onReview) {
      setStudentReviewStatus(message, isError);
      setStatusEl(studentStatus, "", false);
    } else {
      setStudentFormStatus(message, isError);
      setStatusEl(studentReviewStatus, "", false);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth — first Google sign-in writes users/{uid}. Role is sticky after that.
  // ---------------------------------------------------------------------------

  function updateAuthUi() {
    const signedIn = Boolean(authUser);
    const role = userProfile && userProfile.role;
    const isAdmin = role === "admin";

    if (btnSignIn) btnSignIn.hidden = signedIn;
    if (btnSignOut) btnSignOut.hidden = !signedIn;
    if (btnHostApp) btnHostApp.hidden = !signedIn;
    if (btnStudentApp) btnStudentApp.hidden = !signedIn;
    if (btnAdminBoard) btnAdminBoard.hidden = !(signedIn && isAdmin);

    if (authStatus) {
      if (!signedIn) {
        authStatus.textContent = "";
        authStatus.hidden = true;
      } else {
        const label = isAdmin ? "Admin" : role === "host" ? "Host" : "Student";
        authStatus.hidden = false;
        authStatus.textContent =
          (authUser.displayName || authUser.email) + " · " + label;
      }
    }

    if (avatar) {
      if (authUser) {
        avatar.textContent = initialsFrom(authUser.displayName, authUser.email);
        avatar.title = authUser.email || "";
      } else {
        avatar.textContent = "?";
        avatar.title = "";
      }
    }
  }

  /**
   * Load or create users/{uid}. New accounts get pendingRole (student|host).
   * Existing docs are returned as-is — this never upgrades anyone to admin.
   */
  async function ensureUserProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    if (snap.exists) {
      return snap.data();
    }
    const profile = {
      email: user.email || "",
      displayName: user.displayName || "",
      photoURL: user.photoURL || "",
      role: pendingRole === "host" ? "host" : "student",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(profile);
    return profile;
  }

  // ---------------------------------------------------------------------------
  // Form widgets — pills (data-choice / data-multi), acks, skill ratings.
  // ---------------------------------------------------------------------------

  function getChoiceValue(name, defaults) {
    const group = document.querySelector('[data-choice="' + name + '"]');
    if (!group) return (defaults && defaults[name]) || "";
    const active = group.querySelector(".pill.is-active");
    return active
      ? active.getAttribute("data-value")
      : (defaults && defaults[name]) || "";
  }

  function setChoiceValue(name, value, defaults) {
    const group = document.querySelector('[data-choice="' + name + '"]');
    if (!group) return;
    const target = value || (defaults && defaults[name]);
    group.querySelectorAll(".pill").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-value") === target);
    });
  }

  function getMultiValues(name) {
    return Array.from(
      document.querySelectorAll(
        '[data-multi="' + name + '"] .pill.is-active'
      )
    ).map((el) => el.getAttribute("data-value"));
  }

  function setMultiValues(name, values) {
    const selected = new Set(values || []);
    document
      .querySelectorAll('[data-multi="' + name + '"] .pill')
      .forEach((el) => {
        el.classList.toggle("is-active", selected.has(el.getAttribute("data-value")));
      });
  }

  function getCheckMultiValues(name) {
    return Array.from(
      document.querySelectorAll(
        '[data-check-multi="' + name + '"] .check-item.is-checked'
      )
    ).map((el) => el.getAttribute("data-value"));
  }

  function setCheckMultiValues(name, values) {
    const selected = new Set(values || []);
    document
      .querySelectorAll('[data-check-multi="' + name + '"] .check-item')
      .forEach((el) => {
        el.classList.toggle(
          "is-checked",
          selected.has(el.getAttribute("data-value"))
        );
      });
  }

  function getSkillProficiency() {
    const levels = {};
    STUDENT_RATED_SKILLS.forEach((skill) => {
      const group = document.querySelector(
        '[data-skill-choice="' + skill + '"]'
      );
      if (!group) return;
      const active = group.querySelector(".pill.is-active");
      if (active) levels[skill] = active.getAttribute("data-value");
    });
    return levels;
  }

  function setSkillProficiency(levels) {
    const source = levels || {};
    STUDENT_RATED_SKILLS.forEach((skill) => {
      const group = document.querySelector(
        '[data-skill-choice="' + skill + '"]'
      );
      if (!group) return;
      const target = source[skill] || "";
      group.querySelectorAll(".pill").forEach((btn) => {
        btn.classList.toggle(
          "is-active",
          btn.getAttribute("data-value") === target
        );
      });
    });
  }

  function getAckValue(name) {
    const el = document.querySelector('[data-ack="' + name + '"]');
    return !!(
      el &&
      (el.classList.contains("is-active") || el.classList.contains("is-checked"))
    );
  }

  function setAckValue(name, checked) {
    const el = document.querySelector('[data-ack="' + name + '"]');
    if (!el) return;
    el.classList.toggle("is-active", !!checked);
    if (el.classList.contains("check-item")) {
      el.classList.toggle("is-checked", !!checked);
    }
  }

  // ---------------------------------------------------------------------------
  // Uploads — student PDFs and host logos, 10 MB cap. Paths: see storage.rules.
  // ---------------------------------------------------------------------------

  function uploadZone(docType) {
    return document.querySelector('[data-upload="' + docType + '"]');
  }

  function renderDocumentSlot(docType) {
    const zone = uploadZone(docType);
    if (!zone) return;
    const meta = docType === "logo" ? hostLogo : studentDocuments[docType];
    const empty = zone.querySelector(".upload-empty");
    const filled = zone.querySelector(".upload-filled");
    const nameEl = zone.querySelector(".upload-filename");
    const hasFile = !!(meta && meta.fileName);
    zone.classList.toggle("is-uploaded", hasFile);
    if (empty) empty.hidden = hasFile;
    if (filled) filled.hidden = !hasFile;
    if (nameEl) nameEl.textContent = hasFile ? meta.fileName : "";
  }

  function setStudentDocuments(docs) {
    studentDocuments = {
      resume: (docs && docs.resume) || null,
      transcript: (docs && docs.transcript) || null,
    };
    STUDENT_DOC_TYPES.forEach(renderDocumentSlot);
  }

  function setHostLogo(meta) {
    hostLogo = meta || null;
    renderDocumentSlot("logo");
  }

  function logoContentType(file) {
    if (file && file.type && LOGO_MIME_TYPES.indexOf(file.type) !== -1) {
      return file.type;
    }
    const name = (file && file.name) || "";
    if (/\.png$/i.test(name)) return "image/png";
    if (/\.jpe?g$/i.test(name)) return "image/jpeg";
    if (/\.webp$/i.test(name)) return "image/webp";
    if (/\.pdf$/i.test(name)) return "application/pdf";
    return "";
  }

  function isAllowedLogoFile(file) {
    if (!file) return false;
    if (LOGO_MIME_TYPES.indexOf(file.type) !== -1) return true;
    return LOGO_EXT_RE.test(file.name || "");
  }

  async function uploadStudentDocument(docType, file) {
    if (!authUser) {
      setStudentFormStatus("Sign in with Google to upload documents.", true);
      return;
    }
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStudentFormStatus("Please upload a PDF file.", true);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStudentFormStatus("That file is larger than 10MB.", true);
      return;
    }

    const zone = uploadZone(docType);
    if (zone) zone.classList.add("is-uploading");
    setStudentFormStatus("Uploading " + (docType === "resume" ? "resume" : "transcript") + "…");

    try {
      const path =
        "students/" + authUser.uid + "/" + docType + "/" + docType + ".pdf";
      const ref = storage.ref(path);
      await ref.put(file, { contentType: "application/pdf" });
      const url = await ref.getDownloadURL();
      studentDocuments[docType] = {
        fileName: file.name,
        storagePath: path,
        downloadURL: url,
        contentType: "application/pdf",
        size: file.size,
        uploadedAt: new Date().toISOString(),
      };
      renderDocumentSlot(docType);
      setStudentFormStatus(
        (docType === "resume" ? "Resume" : "Transcript") + " uploaded."
      );
    } catch (err) {
      console.error(err);
      setStudentFormStatus(
        "Upload failed: " + (err && err.message ? err.message : err),
        true
      );
    } finally {
      if (zone) zone.classList.remove("is-uploading");
    }
  }

  async function uploadHostLogo(file) {
    if (!authUser) {
      setHostUploadStatus("Sign in with Google to upload a logo.", true);
      return;
    }
    if (!file) return;
    if (!isAllowedLogoFile(file)) {
      setHostUploadStatus(
        "Please upload a PNG, JPG, WebP, or PDF logo file.",
        true
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setHostUploadStatus("That file is larger than 10MB.", true);
      return;
    }

    const zone = uploadZone("logo");
    if (zone) zone.classList.add("is-uploading");
    setHostUploadStatus("Uploading logo…");

    try {
      const contentType = logoContentType(file) || "application/octet-stream";
      const path = "projects/" + authUser.uid + "/logo/logo";
      const ref = storage.ref(path);
      await ref.put(file, { contentType: contentType });
      const url = await ref.getDownloadURL();
      setHostLogo({
        fileName: file.name,
        storagePath: path,
        downloadURL: url,
        contentType: contentType,
        size: file.size,
        uploadedAt: new Date().toISOString(),
      });
      setHostUploadStatus("Logo uploaded.");
    } catch (err) {
      console.error(err);
      setHostUploadStatus(
        "Logo upload failed: " + (err && err.message ? err.message : err),
        true
      );
    } finally {
      if (zone) zone.classList.remove("is-uploading");
    }
  }

  function splitFullName(fullName) {
    const parts = String(fullName || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return {
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
    };
  }

  function formatInterestLabels(values) {
    return (values || []).map((v) => INTEREST_LABELS[v] || v).join(", ");
  }

  function formatSkillProficiency(levels) {
    return Object.entries(levels || {})
      .map(([skill, level]) => skill + " — " + level)
      .join(" · ");
  }

  function getDeliverables() {
    return Array.from(
      document.querySelectorAll("#host-deliverables .check-item.is-checked")
    ).map((el) => el.getAttribute("data-value"));
  }

  function setDeliverables(values) {
    const selected = new Set(values || []);
    document.querySelectorAll("#host-deliverables .check-item").forEach((el) => {
      el.classList.toggle(
        "is-checked",
        selected.has(el.getAttribute("data-value"))
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Host application — one projects/{id} per Google account (query limit 1).
  // ---------------------------------------------------------------------------

  function readHostForm() {
    const data = {};
    HOST_TEXT_FIELDS.forEach((name) => {
      const el = hostForm && hostForm.elements.namedItem(name);
      data[name] = el ? String(el.value || "").trim() : "";
    });
    Object.keys(HOST_CHOICE_DEFAULTS).forEach((name) => {
      data[name] = getChoiceValue(name, HOST_CHOICE_DEFAULTS);
    });
    data.deliverables = getDeliverables();
    data.logo = hostLogo;
    data.logoUsageConsent = getAckValue("logoUsageConsent");
    return data;
  }

  function fillHostForm(data) {
    if (!hostForm) return;
    HOST_TEXT_FIELDS.forEach((name) => {
      const el = hostForm.elements.namedItem(name);
      if (el) el.value = (data && data[name]) || "";
    });
    Object.keys(HOST_CHOICE_DEFAULTS).forEach((name) => {
      setChoiceValue(
        name,
        (data && data[name]) || HOST_CHOICE_DEFAULTS[name],
        HOST_CHOICE_DEFAULTS
      );
    });
    setDeliverables((data && data.deliverables) || []);
    setHostLogo((data && data.logo) || null);
    setAckValue("logoUsageConsent", !!(data && data.logoUsageConsent));
  }

  function resetHostFormDefaults() {
    hostProjectId = null;
    hostProjectLoaded = false;
    fillHostForm({
      supervisorName: authUser ? authUser.displayName || "" : "",
      supervisorEmail: authUser ? authUser.email || "" : "",
    });
    setHostStatus("");
  }

  async function loadHostProject() {
    if (!authUser) {
      setHostStatus("Sign in with Google to start or edit your project.", true);
      return;
    }
    if (hostProjectLoaded) return;

    const snap = await db
      .collection("projects")
      .where("ownerUid", "==", authUser.uid)
      .limit(1)
      .get();

    if (snap.empty) {
      resetHostFormDefaults();
      hostProjectLoaded = true;
      setHostStatus("No saved project yet — fill the form and save a draft.");
      return;
    }

    const doc = snap.docs[0];
    hostProjectId = doc.id;
    const data = doc.data();
    fillHostForm(data);
    hostProjectLoaded = true;
    setHostStatus(
      "Loaded " +
        (data.status || "draft") +
        (data.projectTitle ? ': "' + data.projectTitle + '"' : "") +
        ". You can edit and save again."
    );
  }

  // Keep in step with firestore.rules and the maxlength attributes in index.html.
  const HOST_FIELD_CAPS = [
    ["projectTitle", "Project Title", 300],
    ["companyName", "Company Name", 300],
    ["description", "Description", 20000],
    ["internLogistics", "Intern logistics", 20000],
    ["technicalSkills", "Technical skills", 20000],
    ["officeCulture", "Office culture", 20000],
    ["notes", "Additional notes", 20000],
  ];
  const STUDENT_FIELD_CAPS = [
    ["chicagoEcosystem", "Chicago ecosystem", 20000],
    ["whyInternship", "Why this internship", 20000],
    ["additionalAcademics", "Additional academics", 20000],
    ["courseworkOther", "Other coursework", 20000],
  ];

  /**
   * Message for the first over-cap field, or "". maxlength stops typing, but a
   * legacy doc can load over the cap, and rules would answer with a raw denial.
   */
  function overCapMessage(data, caps) {
    for (const [field, label, cap] of caps) {
      const size = String(data[field] || "").length;
      if (size > cap) {
        return (
          label + " is too long: " + size.toLocaleString("en-US") +
          " characters, and the limit is " + cap.toLocaleString("en-US") +
          ". Shorten it and save again."
        );
      }
    }
    return "";
  }

  /** The public subset of a project: exactly the fields rules allow in catalog/{id}. */
  function catalogEntry(project) {
    return {
      projectTitle: project.projectTitle || "",
      companyName: project.companyName || "",
      status: project.status,
      ownerUid: project.ownerUid || "",
      createdAt: project.createdAt ?? null,
    };
  }

  /** Create or update the host's project. status is draft | submitted. */
  async function saveHostProject(status) {
    if (!authUser) {
      setHostStatus("Sign in with Google to save your project.", true);
      return;
    }

    const payload = readHostForm();
    const hostOverCap = overCapMessage(payload, HOST_FIELD_CAPS);
    if (hostOverCap) {
      setHostStatus(hostOverCap, true);
      return;
    }
    if (status === "submitted" && !payload.projectTitle) {
      setHostStatus("Add a project title before submitting.", true);
      return;
    }

    payload.ownerUid = authUser.uid;
    payload.ownerEmail = authUser.email || "";
    payload.status = status;
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

    const batch = db.batch();
    if (hostProjectId) {
      const projectRef = db.collection("projects").doc(hostProjectId);
      const catalogRef = db.collection("catalog").doc(hostProjectId);
      const existing = await projectRef.get();
      const prev = existing.exists ? existing.data() : {};
      if (status === "submitted" && !("reviewStatus" in prev)) {
        payload.reviewStatus = "submitted";
      }
      batch.update(projectRef, payload);
      // A legacy host may have no entry yet: a draft must not publish one.
      if (status === "submitted" || (await catalogRef.get()).exists) {
        batch.set(catalogRef, catalogEntry({ ...payload, createdAt: prev.createdAt }));
      }
      await batch.commit();
    } else {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (status === "submitted") payload.reviewStatus = "submitted";
      const ref = db.collection("projects").doc();
      batch.set(ref, payload);
      if (status === "submitted") {
        batch.set(db.collection("catalog").doc(ref.id), catalogEntry(payload));
      }
      await batch.commit();
      hostProjectId = ref.id;
    }

    hostProjectLoaded = true;
    setHostStatus(
      status === "submitted"
        ? "Project submitted. You can still edit and save changes later."
        : "Draft saved. Sign in again anytime to continue editing."
    );
  }

  // ---------------------------------------------------------------------------
  // Student application — four wizard steps share one students/{id} document.
  // ---------------------------------------------------------------------------

  function readStudentForm() {
    const data = {};
    document.querySelectorAll("[data-student-field]").forEach((el) => {
      data[el.getAttribute("data-student-field")] = String(el.value || "").trim();
    });
    Object.keys(STUDENT_CHOICE_DEFAULTS).forEach((name) => {
      data[name] = getChoiceValue(name, STUDENT_CHOICE_DEFAULTS);
    });
    STUDENT_MULTI_FIELDS.forEach((name) => {
      data[name] = getMultiValues(name);
    });
    STUDENT_CHECK_MULTI_FIELDS.forEach((name) => {
      data[name] = getCheckMultiValues(name);
    });
    STUDENT_ACK_FIELDS.forEach((name) => {
      data[name] = getAckValue(name);
    });

    data.skillProficiency = getSkillProficiency();
    data.skills = Object.keys(data.skillProficiency);
    data.anyProjectFits = data.anyProjectFits === "Yes";
    // Matching still expects a summer 9-to-5 availability flag; default Yes.
    data.availableSummer = true;
    const names = splitFullName(data.fullName);
    data.firstName = names.firstName;
    data.lastName = names.lastName;
    data.homeAddress = data.mailingAddress || "";
    data.highSchool = data.illinoisHighSchool || data.nonIllinoisSchool || "";
    data.resume = studentDocuments.resume;
    data.transcript = studentDocuments.transcript;
    data.projectChoices = studentChoices.map((c) => ({
      docId: c.docId,
      projectId: c.projectId,
      title: c.title,
    }));
    return data;
  }

  function fillStudentForm(data) {
    const source = data || {};
    let fullName = source.fullName || "";
    if (!fullName) {
      fullName = [source.firstName, source.lastName].filter(Boolean).join(" ");
    }
    if (!source.mailingAddress && source.homeAddress) {
      source.mailingAddress = source.homeAddress;
    }
    if (!source.illinoisHighSchool && source.highSchool) {
      source.illinoisHighSchool = source.highSchool;
    }

    document.querySelectorAll("[data-student-field]").forEach((el) => {
      const key = el.getAttribute("data-student-field");
      if (key === "fullName") {
        el.value = fullName;
        return;
      }
      el.value = source[key] == null ? "" : source[key];
    });
    Object.keys(STUDENT_CHOICE_DEFAULTS).forEach((name) => {
      let value = source[name];
      if (name === "anyProjectFits") {
        value = source.anyProjectFits ? "Yes" : "No";
      }
      setChoiceValue(name, value, STUDENT_CHOICE_DEFAULTS);
    });
    STUDENT_MULTI_FIELDS.forEach((name) => {
      let values = source[name];
      if (name === "raceEthnicity" && typeof values === "string" && values) {
        values = values.split(",").map((s) => s.trim()).filter(Boolean);
      }
      setMultiValues(name, values);
    });
    STUDENT_CHECK_MULTI_FIELDS.forEach((name) =>
      setCheckMultiValues(name, source[name])
    );
    STUDENT_ACK_FIELDS.forEach((name) => setAckValue(name, source[name]));

    if (source.skillProficiency && typeof source.skillProficiency === "object") {
      setSkillProficiency(source.skillProficiency);
    } else if (Array.isArray(source.skills) && source.skills.length) {
      const legacy = {};
      source.skills.forEach((skill) => {
        if (STUDENT_RATED_SKILLS.includes(skill)) legacy[skill] = "Competent";
      });
      setSkillProficiency(legacy);
    } else {
      setSkillProficiency({});
    }

    studentChoices = Array.isArray(source.projectChoices)
      ? source.projectChoices.slice()
      : [];
    setStudentDocuments({
      resume: source.resume || null,
      transcript: source.transcript || null,
    });
    renderProjectChoices();
  }

  function resetStudentFormDefaults() {
    studentDocId = null;
    fillStudentForm({
      fullName: (authUser && authUser.displayName) || "",
      personalEmail: (authUser && authUser.email) || "",
    });
  }

  /**
   * Submitted projects students can rank, read from the public catalog. Cached until the next auth change
   * (`projectCatalogLoaded` is cleared in onAuthStateChanged).
   */
  async function loadProjectCatalog() {
    if (projectCatalogLoaded) return projectCatalog;
    const snap = await db
      .collection("catalog")
      .where("status", "==", "submitted")
      .get();
    projectCatalog = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort(sortByCreatedAt)
      .map((doc, i) => ({
        docId: doc.id,
        projectId: i + 1,
        title: doc.projectTitle || "Untitled project",
        company: doc.companyName || "",
      }));
    projectCatalogLoaded = true;
    return projectCatalog;
  }

  function renderProjectChoices() {
    if (!studentChoicesEl) return;

    if (!projectCatalog.length) {
      studentChoicesEl.innerHTML =
        '<p class="looking-empty">No submitted projects are available to rank yet. You can still finish and submit the rest of your application.</p>';
      return;
    }

    const ranks = new Map(
      studentChoices.map((c, i) => [c.docId, i + 1])
    );

    studentChoicesEl.innerHTML = projectCatalog
      .map((project) => {
        const rank = ranks.get(project.docId);
        return (
          '<button type="button" class="student-choice' +
          (rank ? " is-chosen" : "") +
          '" data-project-doc="' +
          escapeHtml(project.docId) +
          '">' +
          '<span class="student-choice-rank">' +
          (rank ? "#" + rank : "+") +
          "</span>" +
          '<span class="student-choice-body">' +
          "<strong>" +
          escapeHtml(project.title) +
          "</strong>" +
          (project.company
            ? '<span class="student-choice-company">' +
              escapeHtml(project.company) +
              "</span>"
            : "") +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    if (studentChoicesMeta) {
      studentChoicesMeta.textContent = studentChoices.length
        ? studentChoices.length +
          " project(s) ranked — click again to remove, order is your preference."
        : "Click projects in the order you prefer them. Your first pick counts most.";
    }
  }

  function toggleProjectChoice(docId) {
    const existing = studentChoices.findIndex((c) => c.docId === docId);
    if (existing >= 0) {
      studentChoices.splice(existing, 1);
    } else {
      const project = projectCatalog.find((p) => p.docId === docId);
      if (project) {
        studentChoices.push({
          docId: project.docId,
          projectId: project.projectId,
          title: project.title,
        });
      }
    }
    renderProjectChoices();
  }

  async function loadStudentApplication() {
    if (!authUser) {
      setStudentStatus("Sign in with Google to save your application.", true);
      return;
    }
    if (studentDocLoaded) return;

    await loadProjectCatalog().catch((err) => {
      console.error(err);
      if (studentChoicesMeta) {
        studentChoicesMeta.textContent =
          "Could not load the project list: " + err.message;
      }
    });

    const snap = await db
      .collection("students")
      .where("ownerUid", "==", authUser.uid)
      .limit(1)
      .get();

    if (snap.empty) {
      resetStudentFormDefaults();
      studentDocLoaded = true;
      setStudentStatus("No saved application yet — fill it in and save a draft.");
      if (currentView === "apply-4") renderStudentReview();
      return;
    }

    const doc = snap.docs[0];
    studentDocId = doc.id;
    const data = doc.data();
    fillStudentForm(data);
    studentDocLoaded = true;
    setStudentStatus(
      "Loaded your " + (data.status || "draft") + " application. You can edit and save again."
    );
    if (currentView === "apply-4") renderStudentReview();
  }

  /** Persist the wizard to students/{id}. status is draft | submitted. */
  async function saveStudentApplication(status) {
    if (!authUser) {
      setStudentReviewStatus("Sign in with Google to save your application.", true);
      return;
    }

    const payload = readStudentForm();
    const studentOverCap = overCapMessage(payload, STUDENT_FIELD_CAPS);
    if (studentOverCap) {
      setStudentReviewStatus(studentOverCap, true);
      return;
    }
    if (status === "submitted") {
      if (!payload.fullName) {
        setStudentReviewStatus("Add your full name before submitting.", true);
        return;
      }
      if (!payload.personalEmail) {
        setStudentReviewStatus("Add a personal email before submitting.", true);
        return;
      }
      if (!payload.confirmSubmit) {
        setStudentReviewStatus(
          "Confirm that your application is accurate before submitting.",
          true
        );
        return;
      }
    }

    // Keep GPA as entered text (e.g. "3.7 / 4.0"); matcher parses the number later.
    payload.ownerUid = authUser.uid;
    payload.ownerEmail = authUser.email || "";
    payload.status = status;
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

    if (studentDocId) {
      if (status === "submitted") {
        const existing = await db.collection("students").doc(studentDocId).get();
        const prev = existing.exists ? existing.data() : {};
        if (!("reviewStatus" in prev)) {
          payload.reviewStatus = "submitted";
        }
      }
      await db.collection("students").doc(studentDocId).update(payload);
    } else {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (status === "submitted") payload.reviewStatus = "submitted";
      const ref = await db.collection("students").add(payload);
      studentDocId = ref.id;
    }

    studentDocLoaded = true;
    setStudentReviewStatus(
      status === "submitted"
        ? "Application submitted. You can still edit and save changes later."
        : "Draft saved. Sign in again anytime to continue."
    );
    renderStudentReview();
  }

  function kvRows(pairs) {
    return pairs
      .map(
        ([key, value]) =>
          '<div class="kv-row"><span class="k">' +
          escapeHtml(key) +
          '</span><span class="v">' +
          escapeHtml(value || "—") +
          "</span></div>"
      )
      .join("");
  }

  function renderStudentReview() {
    const data = readStudentForm();
    const profile = document.getElementById("student-review-profile");
    const skills = document.getElementById("student-review-skills");
    const availability = document.getElementById("student-review-availability");

    if (profile) {
      profile.innerHTML = kvRows([
        ["Full name", data.fullName],
        ["Preferred name", data.preferredName],
        ["Pronouns", data.pronouns],
        ["Gender", data.gender],
        ["Personal email", data.personalEmail],
        ["School email", data.schoolEmail],
        ["Phone number", data.phone],
        ["Race / ethnicity", (data.raceEthnicity || []).join(", ")],
        ["Birthday", data.birthday],
        ["Age at program start", data.ageAtStart],
        ["Mailing address", data.mailingAddress],
        ["Summer address", data.summerAddress],
        ["Live in Illinois?", data.illinoisResident],
        ["U.S. citizen?", data.usCitizen],
        ["Illinois high school", data.illinoisHighSchool],
        ["Non-IL school / GED", data.nonIllinoisSchool],
        ["College / university", data.college],
        ["Major", data.major],
        ["Minor", data.minor],
        ["Year", data.year],
        ["Graduation year", data.gradYear],
        ["GPA", data.gpa],
        [
          "Resume",
          data.resume && data.resume.fileName ? data.resume.fileName : "",
        ],
        [
          "Unofficial transcript",
          data.transcript && data.transcript.fileName
            ? data.transcript.fileName
            : "",
        ],
      ]);
    }
    if (skills) {
      skills.innerHTML = kvRows([
        ["Skill proficiency", formatSkillProficiency(data.skillProficiency)],
        ["Areas of interest", formatInterestLabels(data.interests)],
        ["Coursework — high school", (data.courseworkHs || []).join(", ")],
        ["Coursework — college", (data.courseworkCollege || []).join(", ")],
        ["Other coursework", data.courseworkOther],
        [
          "Chicago tech ecosystem response",
          data.chicagoEcosystem ? "Provided" : "",
        ],
        ["Why interested response", data.whyInternship ? "Provided" : ""],
        [
          "Additional academics",
          data.additionalAcademics ? "Provided" : "",
        ],
      ]);
    }
    if (availability) {
      const acks = [];
      if (data.ackCommitment) acks.push("Program commitment & drop policy");
      if (data.ackOrientation) acks.push("Virtual orientation attendance");
      if (data.ackAbsences) acks.push("Two absences allowed");
      if (data.ackProgramDates) acks.push("Program start and end dates");
      availability.innerHTML =
        kvRows([
          ["Project length", data.projectLength],
          ["Type of transportation", data.transportation],
          ["Laptop access", data.laptopAccess],
          ["Emergency contact", data.emergencyContact],
          [
            "Ranked projects",
            studentChoices.map((c, i) => i + 1 + ". " + c.title).join(" · "),
          ],
          ["Open to any project", data.anyProjectFits ? "Yes" : "No"],
          ["Acknowledgements", acks.join(" · ")],
        ]);
    }
  }

  function onEnterApplyView(name) {
    if (authUser) {
      loadStudentApplication().catch((err) =>
        setStudentStatus(err.message, true)
      );
    } else {
      setStudentStatus("Sign in with Google to save your application.", true);
    }
    if (name === "apply-3") renderProjectChoices();
    if (name === "apply-4") renderStudentReview();
  }

  // ---------------------------------------------------------------------------
  // Admin roster — live listeners, Kanban, project detail, Excel export.
  // ---------------------------------------------------------------------------

  function sortByCreatedAt(a, b) {
    const at = (a.createdAt && a.createdAt.toMillis && a.createdAt.toMillis()) || 0;
    const bt = (b.createdAt && b.createdAt.toMillis && b.createdAt.toMillis()) || 0;
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  }

  function sortByUpdatedAt(a, b) {
    const at = (a.updatedAt && a.updatedAt.toMillis && a.updatedAt.toMillis()) || 0;
    const bt = (b.updatedAt && b.updatedAt.toMillis && b.updatedAt.toMillis()) || 0;
    return bt - at;
  }

  /**
   * Project numbers are assigned by creation order so the host export, the
   * student export, and a Firestore cohort build all agree on "Project N".
   * Export both workbooks from the same admin session or rankings drift.
   */
  function assignProjectNumbers(projects) {
    const ordered = projects.slice().sort(sortByCreatedAt);
    const numbers = new Map();
    ordered.forEach((project, i) => numbers.set(project.id, i + 1));
    return numbers;
  }

  function projectRows(projects) {
    const numbers = assignProjectNumbers(projects);
    return projects
      .slice()
      .sort(sortByCreatedAt)
      .map((project, i) =>
        window.DpiCohort.projectDocToRow(
          { ...project, projectNumber: numbers.get(project.id) },
          i
        )
      );
  }

  function studentRows(students, projects) {
    const numbers = assignProjectNumbers(projects);
    return students
      .slice()
      .sort(sortByCreatedAt)
      .map((student, i) => {
        const choices = (Array.isArray(student.projectChoices) ? student.projectChoices : []).map((choice) => ({
          ...choice,
          projectId: numbers.get(choice.docId) || choice.projectId,
        }));
        return window.DpiCohort.studentDocToRow(
          { ...student, studentNumber: i + 1, projectChoices: choices },
          i
        );
      });
  }

  function renderProjectCards(projects) {
    if (!adminList) return;
    if (!projects.length) {
      adminList.innerHTML =
        '<p class="looking-empty">No host projects yet.</p>';
      return;
    }
    adminList.innerHTML = projects
      .slice()
      .sort(sortByUpdatedAt)
      .map((p) => {
        const display = projectDisplayStatus(p);
        const slug = projectStatusSlug(p);
        return (
          '<article class="admin-project-card is-clickable" role="button" tabindex="0" data-admin-project-id="' +
          escapeHtml(p.id) +
          '">' +
          "<h4>" +
          escapeHtml(p.projectTitle || "(Untitled project)") +
          "</h4>" +
          '<p class="admin-project-meta"><strong>' +
          escapeHtml(p.companyName || "—") +
          "</strong> · " +
          escapeHtml(p.ownerEmail || p.supervisorEmail || p.ownerUid || "—") +
          ' · <span class="status-pill status-' +
          escapeHtml(slug) +
          '">' +
          escapeHtml(display) +
          "</span></p>" +
          "<p>" +
          escapeHtml(p.technicalSkills || "—") +
          "</p>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderStudentCards(students) {
    if (!adminStudentsList) return;
    if (!students.length) {
      adminStudentsList.innerHTML =
        '<p class="looking-empty">No student applications yet.</p>';
      return;
    }
    adminStudentsList.innerHTML = students
      .slice()
      .sort(sortByUpdatedAt)
      .map((s) => {
        const appStatus = escapeHtml(s.status || "draft");
        const board = resolveStudentBoardStatus(s);
        const name = studentDisplayName(s);
        const ranked = Array.isArray(s.projectChoices) ? s.projectChoices.length : 0;
        return (
          '<article class="admin-project-card">' +
          "<h4>" +
          escapeHtml(name || "(Unnamed applicant)") +
          "</h4>" +
          '<p class="admin-project-meta"><strong>' +
          escapeHtml(s.college || "—") +
          "</strong> · " +
          escapeHtml(s.ownerEmail || s.personalEmail || "—") +
          ' · <span class="status-pill status-' +
          appStatus +
          '">' +
          appStatus +
          "</span>" +
          (board
            ? ' · <span class="status-pill status-' +
              escapeHtml(board) +
              '">' +
              escapeHtml(board) +
              "</span>"
            : "") +
          "</p>" +
          "<p>" +
          escapeHtml(
            (s.skills || []).join(", ") ||
              Object.keys(s.skillProficiency || {}).join(", ") ||
              "—"
          ) +
          " · " +
          ranked +
          " ranked project(s)</p>" +
          "</article>"
        );
      })
      .join("");
  }

  function studentDisplayName(s) {
    return (
      s.fullName ||
      [s.firstName, s.lastName].filter(Boolean).join(" ") ||
      ""
    );
  }

  function studentEduLine(s) {
    const parts = [s.major, s.year].filter(Boolean);
    return parts.length ? parts.join(", ") : "Degree / year not provided";
  }

  function studentSkillList(s) {
    if (Array.isArray(s.skills) && s.skills.length) return s.skills.slice(0, 8);
    return Object.keys(s.skillProficiency || {}).slice(0, 8);
  }

  /** Kanban column for a submitted student. Drafts are omitted from the board. */
  function resolveStudentBoardStatus(student) {
    if ((student.status || "draft") !== "submitted") return null;
    const review = String(student.reviewStatus || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (STUDENT_BOARD_STATUSES.includes(review)) return review;
    return "submitted";
  }

  function projectDisplayStatus(project) {
    const review = String(project.reviewStatus || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (review === "approved") return "Approved";
    if (review === "changes_requested") return "Changes requested";
    if (review === "archived") return "Archived";
    if ((project.status || "draft") === "submitted") return "Submitted";
    return "Draft";
  }

  function projectStatusSlug(project) {
    const review = String(project.reviewStatus || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (PROJECT_REVIEW_STATUSES.includes(review) && review !== "submitted") {
      return review;
    }
    return project.status || "draft";
  }

  function initialsFromName(name) {
    return initialsFrom(name || "?", "");
  }

  function formatAdminDate(value) {
    if (!value) return "";
    let date = null;
    if (value.toDate) date = value.toDate();
    else if (typeof value === "string" || typeof value === "number") {
      date = new Date(value);
    }
    if (!date || Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function parseInternSpots(project) {
    if (project.internsNeeded && Number(project.internsNeeded) > 0) {
      return Number(project.internsNeeded);
    }
    const text = String(project.internLogistics || "");
    const match = text.match(/(\d+)/);
    return match ? Math.max(1, Number(match[1])) : 1;
  }

  function tokenizeSkills(text) {
    return String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9+#/.]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);
  }

  /**
   * Decorative 32–97% for the admin project sidebar. Not matcher score C.
   * Built from token overlap on technicalSkills plus a ranking bonus.
   */
  function estimateMatchPercent(student, project) {
    const projectSkills = tokenizeSkills(project.technicalSkills);
    const studentSkills = studentSkillList(student).map((s) =>
      String(s).toLowerCase()
    );
    let overlap = 0;
    if (projectSkills.length) {
      projectSkills.forEach((ps) => {
        if (
          studentSkills.some(
            (ss) => ss === ps || ss.includes(ps) || ps.includes(ss)
          )
        ) {
          overlap += 1;
        }
      });
    }
    let score = projectSkills.length
      ? overlap / projectSkills.length
      : studentSkills.length
        ? 0.55
        : 0.4;

    const choices = Array.isArray(student.projectChoices)
      ? student.projectChoices
      : [];
    const rank = choices.findIndex(
      (c) => c && (c.docId === project.id || c.title === project.projectTitle)
    );
    if (rank === 0) score += 0.22;
    else if (rank === 1) score += 0.14;
    else if (rank === 2) score += 0.08;
    else if (rank >= 0) score += 0.04;
    else if (student.anyProjectFits) score += 0.06;

    return Math.round(Math.min(0.97, Math.max(0.32, score)) * 100);
  }

  function suggestedMatchesForProject(project, students, limit) {
    const assignedIds = new Set(
      (project.assignedInterns || []).map((a) => a.studentId)
    );
    return students
      .filter((s) => (s.status || "") === "submitted")
      .filter((s) => !assignedIds.has(s.id))
      .filter((s) => resolveStudentBoardStatus(s) !== "denied")
      .map((s) => ({
        student: s,
        percent: estimateMatchPercent(s, project),
      }))
      .sort((a, b) => b.percent - a.percent || studentDisplayName(a.student).localeCompare(studentDisplayName(b.student)))
      .slice(0, limit || 5);
  }

  function renderStudentBoardCard(student) {
    const name = studentDisplayName(student) || "(Unnamed applicant)";
    const skills = studentSkillList(student);
    const tags = skills
      .map((skill) => '<span class="tag">' + escapeHtml(skill) + "</span>")
      .join("");
    const matchLine =
      resolveStudentBoardStatus(student) === "matched" && student.matchedProject
        ? '<div class="match-line">Matched: ' +
          escapeHtml(student.matchedProject) +
          "</div>"
        : "";
    return (
      '<article class="applicant" draggable="true" data-student-id="' +
      escapeHtml(student.id) +
      '">' +
      "<h4>" +
      escapeHtml(name) +
      "</h4>" +
      '<p class="edu">' +
      escapeHtml(studentEduLine(student)) +
      "</p>" +
      (tags ? '<div class="tags">' + tags + "</div>" : "") +
      matchLine +
      "</article>"
    );
  }

  function renderAdminStudentBoard(students) {
    const board = document.getElementById("admin-student-board");
    if (!board) return;

    const buckets = {
      waitlisted: [],
      submitted: [],
      denied: [],
      reviewing: [],
      matched: [],
    };
    students.forEach((student) => {
      const col = resolveStudentBoardStatus(student);
      if (col && buckets[col]) buckets[col].push(student);
    });

    STUDENT_BOARD_STATUSES.forEach((status) => {
      const column = board.querySelector(
        '[data-board-status="' + status + '"]'
      );
      if (!column) return;
      const list = buckets[status].slice().sort(sortByUpdatedAt);
      const countEl = column.querySelector("[data-board-count]");
      const cardsEl = column.querySelector("[data-board-cards]");
      if (countEl) countEl.textContent = String(list.length);
      if (cardsEl) {
        cardsEl.innerHTML = list.map(renderStudentBoardCard).join("");
      }
    });
  }

  function updateAdminStats(projects, students) {
    const drafts = students.filter((s) => (s.status || "draft") === "draft")
      .length;
    const submitted = students.filter(
      (s) => (s.status || "") === "submitted"
    ).length;
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };
    setText("stat-host-projects", projects.length);
    setText("stat-students", students.length);
    setText("stat-drafts", drafts);
    setText("stat-submitted", submitted);
    setText("stat-students-meta", submitted + " submitted");
  }

  function applyAdminRoster(projects, students) {
    adminProjectsCache = projects;
    adminStudentsCache = students;
    updateAdminStats(projects, students);
    renderProjectCards(projects);
    renderStudentCards(students);
    renderAdminStudentBoard(students);
    if (adminMeta) {
      adminMeta.textContent =
        projects.length +
        " host project(s) and " +
        students.length +
        " student application(s) loaded.";
    }
    if (currentView === "admin-project" && selectedAdminProjectId) {
      renderAdminProjectDetail(selectedAdminProjectId);
    }
  }

  /** Stop listeners and drop all admin state. Called on auth change and on listener error. */
  function stopAdminListeners() {
    adminGeneration += 1;
    adminUnsubscribers.forEach((unsub) => {
      try {
        unsub();
      } catch (err) {
        /* ignore */
      }
    });
    adminUnsubscribers = [];
    const rejectPending = adminRejectReady;
    adminRejectReady = null;
    adminReady = null;
    // Settle any caller still waiting; a no-op once the promise has resolved.
    if (rejectPending) rejectPending(new Error("Admin session changed"));
    adminProjectsCache = [];
    adminStudentsCache = [];
  }

  // Admin-only scripts, loaded in order on first admin use so students and
  // hosts never download SheetJS or the matcher. Keep ?v= in step with edits.
  const ADMIN_BUNDLE = [
    "vendor/xlsx-0.20.3.full.min.js?v=1",
    "xlsx-cohort.js?v=4",
    "matcher.js?v=8",
    "alternate-solvers.js?v=2",
    "match-demo.js?v=11",
  ];
  let adminBundlePromise = null;
  const adminScriptsLoaded = new Set(); // a retry skips scripts that already ran

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => {
        adminScriptsLoaded.add(src);
        resolve();
      };
      el.onerror = () => {
        if (el.parentNode) el.parentNode.removeChild(el);
        reject(new Error("Could not load " + src.split("?")[0]));
      };
      document.body.appendChild(el);
    });
  }

  /** Memoized; a failed load clears the memo so the next call retries. */
  function loadAdminBundle() {
    if (adminBundlePromise) return adminBundlePromise;
    adminBundlePromise = (async () => {
      for (const src of ADMIN_BUNDLE) {
        if (!adminScriptsLoaded.has(src)) await loadScriptOnce(src);
      }
    })();
    adminBundlePromise.catch(() => {
      adminBundlePromise = null;
    });
    return adminBundlePromise;
  }

  /**
   * Subscribe to the full projects + students collections. Idempotent: the
   * listeners survive view changes and stop only on auth change or error.
   */
  function startAdminListeners() {
    loadAdminBundle().catch((err) => {
      console.error(err);
      setStatusEl(
        adminExportStatus,
        "Admin tools failed to load: " + err.message + ". Reload to retry.",
        true
      );
    });
    if (adminUnsubscribers.length) return;
    if (adminMeta) adminMeta.textContent = "Loading applications…";

    const generation = adminGeneration;
    let projectsReady = false;
    let studentsReady = false;
    let resolveReady;
    let rejectReady;
    adminReady = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    adminRejectReady = rejectReady;
    adminReady.catch(() => {}); // callers handle it; avoid unhandled rejection noise
    const readyPromise = adminReady;

    const maybeApply = () => {
      if (generation !== adminGeneration) return;
      if (!projectsReady || !studentsReady) return;
      applyAdminRoster(adminProjectsCache, adminStudentsCache);
      resolveReady({ projects: adminProjectsCache, students: adminStudentsCache });
    };

    const fail = (label) => (err) => {
      if (generation !== adminGeneration) return;
      console.error(err);
      if (adminMeta) {
        adminMeta.textContent = "Failed to load " + label + ": " + err.message;
      }
      // Reject first: stopAdminListeners rejects anything pending with a generic
      // "session changed" error. Tear down so the next call retries from scratch.
      rejectReady(err);
      stopAdminListeners();
    };

    adminUnsubscribers.push(
      db.collection("projects").onSnapshot((snap) => {
        if (generation !== adminGeneration) return;
        adminProjectsCache = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        projectsReady = true;
        maybeApply();
      }, fail("projects"))
    );

    adminUnsubscribers.push(
      db.collection("students").onSnapshot((snap) => {
        if (generation !== adminGeneration) return;
        adminStudentsCache = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        studentsReady = true;
        maybeApply();
      }, fail("students"))
    );
    return readyPromise;
  }

  /**
   * Resolves with the live caches after both listeners deliver their first
   * snapshot. Rejects on a listener error. Never resolves with empty
   * placeholder data.
   */
  function adminRosterReady() {
    if (!userProfile || userProfile.role !== "admin") {
      return Promise.reject(new Error("Admin access required."));
    }
    startAdminListeners();
    // Readiness only: read the caches after it settles, since later snapshots
    // replace the arrays and a settled promise would hold the first ones.
    return adminReady.then(() => ({
      projects: adminProjectsCache,
      students: adminStudentsCache,
    }));
  }

  /** Refresh re-renders from the cache; the listeners keep it current. */
  async function loadAdminRoster() {
    const { projects, students } = await adminRosterReady();
    applyAdminRoster(projects, students);
    return { projects, students };
  }

  function completenessChecks(project) {
    const hasSupervisor =
      Boolean(project.supervisorName || project.companyName) &&
      Boolean(project.supervisorEmail || project.ownerEmail);
    const hasDetails = Boolean(
      project.projectTitle &&
        project.description &&
        (project.internLogistics || project.technicalSkills)
    );
    const hasCulture = Boolean(
      String(project.officeCulture || "").trim() &&
        project.firstInterns &&
        project.interviewInvolvement
    );
    const hasDeliverables =
      Array.isArray(project.deliverables) && project.deliverables.length > 0;

    const missingCulture = [];
    if (!String(project.officeCulture || "").trim()) {
      missingCulture.push("office culture description");
    }
    if (!project.firstInterns) missingCulture.push("first interns answer");
    if (!project.interviewInvolvement) {
      missingCulture.push("interview involvement");
    }

    return [
      {
        ok: hasSupervisor,
        label: "Supervisor & organization info",
      },
      {
        ok: hasDetails,
        label: "Project details & workplan",
      },
      {
        ok: hasCulture,
        label: "Culture & process questions",
        note: missingCulture.length
          ? "Missing: " + missingCulture.join(", ")
          : "",
      },
      {
        ok: hasDeliverables,
        label: "Deliverables selected",
      },
    ];
  }

  function renderAdminProjectDetail(projectId) {
    const project = adminProjectsCache.find((p) => p.id === projectId);
    const titleEl = document.getElementById("apd-title");
    const pillEl = document.getElementById("apd-status-pill");
    const banner = document.getElementById("apd-approval-banner");
    const bannerText = document.getElementById("apd-approval-text");
    const companyCard = document.getElementById("apd-company-card");
    const completenessCard = document.getElementById("apd-completeness-card");
    const detailsCard = document.getElementById("apd-details-card");
    const assignedCard = document.getElementById("apd-assigned-card");
    const statusCard = document.getElementById("apd-sidebar-status");
    const matchesCard = document.getElementById("apd-sidebar-matches");
    const actionsCard = document.getElementById("apd-sidebar-actions");

    if (!project) {
      if (titleEl) titleEl.textContent = "Project not found";
      if (companyCard) {
        companyCard.innerHTML =
          '<p class="apd-empty">This project is missing or still loading.</p>';
      }
      return;
    }

    const display = projectDisplayStatus(project);
    const slug = projectStatusSlug(project);
    const spots = parseInternSpots(project);
    const assigned = Array.isArray(project.assignedInterns)
      ? project.assignedInterns
      : [];
    const suggestions = suggestedMatchesForProject(
      project,
      adminStudentsCache,
      5
    );
    const projectLabel =
      project.projectNumber != null
        ? String(project.projectNumber)
        : project.id.slice(0, 8);

    if (titleEl) {
      titleEl.textContent = project.projectTitle || "(Untitled project)";
    }
    if (pillEl) {
      pillEl.className = "status-pill status-" + slug;
      pillEl.textContent = display;
    }

    if (banner && bannerText) {
      if (slug === "approved") {
        const who =
          project.approvedByName ||
          project.approvedByEmail ||
          "an admin";
        const when =
          formatAdminDate(project.approvedAt) || "an unknown date";
        banner.hidden = false;
        bannerText.textContent =
          "Project approved by " +
          who +
          " on " +
          when +
          ". Suggested intern matches for this project are ready in the sidebar →";
      } else {
        banner.hidden = true;
        bannerText.textContent = "";
      }
    }

    if (companyCard) {
      const company = project.companyName || "Company";
      companyCard.innerHTML =
        '<div class="apd-company">' +
        '<div class="apd-logo">' +
        escapeHtml(initialsFromName(company)) +
        "</div>" +
        "<div>" +
        "<h2>" +
        escapeHtml(company) +
        "</h2>" +
        "<p><strong>Supervisor:</strong> " +
        escapeHtml(project.supervisorName || "—") +
        " · " +
        escapeHtml(project.supervisorEmail || project.ownerEmail || "—") +
        "</p>" +
        "<p><strong>Address:</strong> " +
        escapeHtml(project.workLocations || "—") +
        " · <strong>Project #" +
        escapeHtml(projectLabel) +
        "</strong></p>" +
        "</div></div>";
    }

    if (completenessCard) {
      const checks = completenessChecks(project);
      completenessCard.innerHTML =
        '<p class="apd-kicker">Application completeness</p>' +
        '<ul class="apd-check-list">' +
        checks
          .map((item) => {
            return (
              '<li class="' +
              (item.ok ? "is-ok" : "is-warn") +
              '"><span class="apd-mark" aria-hidden="true">' +
              (item.ok ? "✓" : "!") +
              "</span><div><strong>" +
              escapeHtml(item.label) +
              "</strong>" +
              (!item.ok && item.note
                ? '<span class="apd-warn-note">' +
                  escapeHtml(item.note) +
                  "</span>"
                : "") +
              "</div></li>"
            );
          })
          .join("") +
        "</ul>";
    }

    if (detailsCard) {
      const deliverables = Array.isArray(project.deliverables)
        ? project.deliverables.join(", ")
        : "—";
      detailsCard.innerHTML =
        '<p class="apd-kicker">Project details</p>' +
        '<p class="apd-details-copy">' +
        escapeHtml(project.description || "No description provided.") +
        "</p>" +
        '<dl class="apd-details-grid">' +
        "<div><dt>Interns requested</dt><dd>" +
        escapeHtml(project.internLogistics || spots + " intern(s)") +
        "</dd></div>" +
        "<div><dt>Host days</dt><dd>" +
        escapeHtml(project.hostDays || "—") +
        "</dd></div>" +
        "<div><dt>Team structure</dt><dd>" +
        escapeHtml(project.projectStructure || "—") +
        "</dd></div>" +
        "<div><dt>Technical expertise on team</dt><dd>" +
        escapeHtml(project.expertiseSupport || "—") +
        "</dd></div>" +
        "<div><dt>Skills / tools used</dt><dd>" +
        escapeHtml(project.technicalSkills || "—") +
        "</dd></div>" +
        "<div><dt>Expected deliverables</dt><dd>" +
        escapeHtml(deliverables) +
        "</dd></div>" +
        "</dl>" +
        '<p class="apd-kicker">Culture &amp; process</p>' +
        '<div class="apd-culture-grid">' +
        '<div class="apd-row"><span>First intern(s) for supervisor</span><span>' +
        escapeHtml(project.firstInterns || "—") +
        "</span></div>" +
        '<div class="apd-row"><span>Involved in interviewing</span><span>' +
        escapeHtml(project.interviewInvolvement || "—") +
        "</span></div>" +
        '<div class="apd-row"><span>Office culture</span><span>' +
        escapeHtml(
          String(project.officeCulture || "").trim() || "Not yet provided"
        ) +
        "</span></div>" +
        "</div>";
    }

    if (assignedCard) {
      const rows = assigned.length
        ? assigned
            .map((a) => {
              const name = a.fullName || "Intern";
              const edu = [a.major, a.year].filter(Boolean).join(", ");
              const pct =
                a.matchPercent != null ? " — " + a.matchPercent + "% match" : "";
              return (
                '<div class="apd-assigned-row">' +
                '<div class="apd-logo">' +
                escapeHtml(initialsFromName(name)) +
                "</div>" +
                "<div><strong>" +
                escapeHtml(name) +
                "</strong><span>" +
                escapeHtml((edu || "Applicant") + pct) +
                "</span></div>" +
                '<button type="button" class="btn btn-secondary btn-sm apd-unassign-btn" data-unassign-student="' +
                escapeHtml(a.studentId) +
                '" aria-label="Unassign ' +
                escapeHtml(name) +
                '">Unassign</button></div>'
              );
            })
            .join("")
        : '<p class="apd-empty">No interns assigned yet.</p>';

      assignedCard.innerHTML =
        '<p class="apd-kicker">Assigned interns (' +
        assigned.length +
        " of " +
        spots +
        " spots filled)</p>" +
        rows +
        '<button type="button" class="btn btn-secondary apd-assign-another" id="apd-btn-assign-another"' +
        (assigned.length >= spots ? " disabled" : "") +
        ">+ Assign another intern to this project</button>";
    }

    if (statusCard) {
      statusCard.innerHTML =
        '<p class="apd-kicker">Status</p>' +
        '<span class="status-pill status-' +
        escapeHtml(slug) +
        '">' +
        escapeHtml(display) +
        "</span>";
    }

    if (matchesCard) {
      const body = suggestions.length
        ? suggestions
            .map(({ student, percent }) => {
              const name = studentDisplayName(student) || "Applicant";
              return (
                '<div class="apd-match-item">' +
                '<div class="apd-match-head"><strong>' +
                escapeHtml(name) +
                '</strong><span class="apd-match-pct">' +
                percent +
                "%</span></div>" +
                '<p class="apd-match-edu">' +
                escapeHtml(studentEduLine(student)) +
                "</p>" +
                '<div class="apd-match-bar" aria-hidden="true"><span style="width:' +
                percent +
                '%"></span></div>' +
                '<button type="button" class="btn btn-primary btn-sm" data-assign-student="' +
                escapeHtml(student.id) +
                '">Assign to this project</button>' +
                "</div>"
              );
            })
            .join("")
        : '<p class="apd-empty">No submitted student applications available to suggest yet.</p>';
      matchesCard.innerHTML =
        '<p class="apd-kicker">Suggested intern matches — ready to assign</p>' +
        body;
    }

    if (actionsCard) {
      const top = suggestions[0];
      const topLabel = top
        ? "Assign top match (" +
          (studentDisplayName(top.student) || "applicant") +
          ")"
        : "Assign top match";
      const canApprove = slug !== "approved" && slug !== "archived";
      const topClass = slug === "approved" ? "btn btn-approve" : "btn btn-primary";
      actionsCard.innerHTML =
        '<p class="apd-kicker">Actions</p>' +
        '<div class="apd-actions">' +
        (canApprove
          ? '<button type="button" class="btn btn-approve" id="apd-btn-approve">Approve project</button>'
          : "") +
        '<button type="button" class="' +
        topClass +
        '" id="apd-btn-top-match"' +
        (top && assigned.length < spots ? "" : " disabled") +
        ">" +
        escapeHtml(topLabel) +
        "</button>" +
        '<button type="button" class="btn btn-secondary" id="apd-btn-request-changes">Request changes</button>' +
        '<button type="button" class="btn btn-secondary" id="apd-btn-assign-interns">Assign interns</button>' +
        '<button type="button" class="btn btn-archive" id="apd-btn-archive">Archive project</button>' +
        "</div>";
    }
  }

  function openAdminProject(projectId) {
    selectedAdminProjectId = projectId;
    showView("admin-project");
  }

  async function setProjectReviewStatus(reviewStatus) {
    if (!selectedAdminProjectId) return;
    const payload = {
      reviewStatus: reviewStatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (reviewStatus === "approved") {
      payload.approvedAt = firebase.firestore.FieldValue.serverTimestamp();
      payload.approvedByUid = authUser ? authUser.uid : "";
      payload.approvedByName =
        (userProfile && userProfile.displayName) ||
        (authUser && authUser.displayName) ||
        (authUser && authUser.email) ||
        "Admin";
      payload.approvedByEmail = (authUser && authUser.email) || "";
      const existing = adminProjectsCache.find(
        (p) => p.id === selectedAdminProjectId
      );
      if (existing && existing.status !== "submitted") {
        payload.status = "submitted";
      }
    }
    const batch = db.batch();
    batch.update(db.collection("projects").doc(selectedAdminProjectId), payload);
    if (payload.status) {
      const existing = adminProjectsCache.find(
        (p) => p.id === selectedAdminProjectId
      );
      batch.set(
        db.collection("catalog").doc(selectedAdminProjectId),
        catalogEntry({ ...existing, status: payload.status })
      );
    }
    await batch.commit();
  }

  /**
   * Migration and repair, run by hand from the console. Upserts an entry per
   * project that is submitted, copies the current state onto entries of other
   * projects so they leave the student query, and deletes entries whose project
   * is gone. Returns the count of submitted entries upserted. Never called by
   * the app.
   */
  async function backfillCatalog() {
    if (!userProfile || userProfile.role !== "admin") {
      throw new Error("Admin access only.");
    }
    const [projectSnap, catalogSnap] = await Promise.all([
      db.collection("projects").get(),
      db.collection("catalog").get(),
    ]);
    const catalogRef = (id) => db.collection("catalog").doc(id);
    const projectIds = new Set(projectSnap.docs.map((doc) => doc.id));
    const entryIds = new Set(catalogSnap.docs.map((doc) => doc.id));
    const writes = [];
    let upserted = 0;
    projectSnap.docs.forEach((doc) => {
      const project = doc.data();
      const submitted = project.status === "submitted";
      if (submitted) upserted += 1;
      if (submitted || entryIds.has(doc.id)) {
        writes.push((batch) => batch.set(catalogRef(doc.id), catalogEntry(project)));
      }
    });
    catalogSnap.docs.forEach((doc) => {
      if (!projectIds.has(doc.id)) writes.push((batch) => batch.delete(catalogRef(doc.id)));
    });
    const BATCH_SIZE = 400;
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
      const batch = db.batch();
      writes.slice(i, i + BATCH_SIZE).forEach((write) => write(batch));
      await batch.commit();
    }
    return upserted;
  }

  /**
   * Real placement: append to projects.assignedInterns and set the student
   * reviewStatus to matched. Kanban "Matched" only changes reviewStatus.
   */
  async function assignStudentToProject(studentId, projectId) {
    let project = adminProjectsCache.find((p) => p.id === projectId);
    let student = adminStudentsCache.find((s) => s.id === studentId);

    if (!project) {
      const snap = await db.collection("projects").doc(projectId).get();
      if (!snap.exists) throw new Error("Project not found.");
      project = { id: snap.id, ...snap.data() };
    }
    if (!student) {
      const snap = await db.collection("students").doc(studentId).get();
      if (!snap.exists) throw new Error("Student not found.");
      student = { id: snap.id, ...snap.data() };
    }

    const assigned = Array.isArray(project.assignedInterns)
      ? project.assignedInterns.slice()
      : [];
    if (assigned.some((a) => a.studentId === studentId)) {
      return;
    }
    const spots = parseInternSpots(project);
    if (assigned.length >= spots) {
      throw new Error("All intern spots for this project are already filled.");
    }

    const percent = estimateMatchPercent(student, project);
    const name = studentDisplayName(student) || "Intern";
    assigned.push({
      studentId: studentId,
      fullName: name,
      major: student.major || "",
      year: student.year || "",
      matchPercent: percent,
      assignedAt: new Date().toISOString(),
    });

    const projectTitle =
      project.projectTitle || project.companyName || "Project";

    await db.collection("projects").doc(projectId).update({
      assignedInterns: assigned,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("students").doc(studentId).update({
      reviewStatus: "matched",
      matchedProject: projectTitle,
      matchedProjectId: projectId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function unassignStudentFromProject(studentId, projectId) {
    let project = adminProjectsCache.find((p) => p.id === projectId);
    if (!project) {
      const snap = await db.collection("projects").doc(projectId).get();
      if (!snap.exists) throw new Error("Project not found.");
      project = { id: snap.id, ...snap.data() };
    }

    const assigned = Array.isArray(project.assignedInterns)
      ? project.assignedInterns.slice()
      : [];
    const next = assigned.filter((a) => a.studentId !== studentId);
    if (next.length === assigned.length) {
      return;
    }

    await db.collection("projects").doc(projectId).update({
      assignedInterns: next,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await updateStudentBoardStatus(studentId, "submitted");
  }

  async function updateStudentBoardStatus(studentId, reviewStatus) {
    if (!STUDENT_BOARD_STATUSES.includes(reviewStatus)) return;
    const payload = {
      reviewStatus: reviewStatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (reviewStatus !== "matched") {
      payload.matchedProject = firebase.firestore.FieldValue.delete();
      payload.matchedProjectId = firebase.firestore.FieldValue.delete();
    }
    await db.collection("students").doc(studentId).update(payload);
  }

  /**
   * Kanban drag-and-drop writes reviewStatus only. Dropping on "matched"
   * does not fill an intern seat — use assignStudentToProject for that.
   */
  function bindAdminStudentBoardDnD() {
    if (adminBoardBound) return;
    const board = document.getElementById("admin-student-board");
    if (!board) return;
    adminBoardBound = true;

    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".applicant[data-student-id]");
      if (!card) return;
      dragStudentId = card.getAttribute("data-student-id");
      card.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragStudentId || "");
      }
    });

    board.addEventListener("dragend", (event) => {
      const card = event.target.closest(".applicant");
      if (card) card.classList.remove("is-dragging");
      board
        .querySelectorAll(".column.is-drop-target")
        .forEach((col) => col.classList.remove("is-drop-target"));
      dragStudentId = null;
    });

    board.addEventListener("dragover", (event) => {
      const column = event.target.closest("[data-board-status]");
      if (!column || !dragStudentId) return;
      event.preventDefault();
      board
        .querySelectorAll(".column.is-drop-target")
        .forEach((col) => col.classList.remove("is-drop-target"));
      column.classList.add("is-drop-target");
    });

    board.addEventListener("dragleave", (event) => {
      const column = event.target.closest("[data-board-status]");
      if (column && !column.contains(event.relatedTarget)) {
        column.classList.remove("is-drop-target");
      }
    });

    board.addEventListener("drop", (event) => {
      const column = event.target.closest("[data-board-status]");
      if (!column) return;
      event.preventDefault();
      column.classList.remove("is-drop-target");
      const studentId =
        dragStudentId ||
        (event.dataTransfer && event.dataTransfer.getData("text/plain"));
      const nextStatus = column.getAttribute("data-board-status");
      if (!studentId || !nextStatus) return;
      updateStudentBoardStatus(studentId, nextStatus).catch((err) => {
        console.error(err);
        alert("Could not update student status: " + err.message);
      });
    });
  }

  /** Download the compiled host or student workbook (SheetJS). */
  async function exportWorkbook(kind) {
    setStatusEl(adminExportStatus, "Building workbook…");
    try {
      await loadAdminBundle();
      const { projects, students } = await adminRosterReady();

      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "students") {
        const rows = studentRows(students, projects);
        window.DpiCohort.downloadWorkbook(
          rows,
          window.DpiCohort.STUDENT_COLUMNS,
          "Students",
          "student-applications-" + stamp + ".xlsx"
        );
        setStatusEl(
          adminExportStatus,
          "Exported " + rows.length + " student application(s)."
        );
      } else {
        const rows = projectRows(projects);
        window.DpiCohort.downloadWorkbook(
          rows,
          window.DpiCohort.HOST_COLUMNS,
          "Host projects",
          "host-applications-" + stamp + ".xlsx"
        );
        setStatusEl(
          adminExportStatus,
          "Exported " + rows.length + " host project(s)."
        );
      }
    } catch (err) {
      console.error(err);
      setStatusEl(adminExportStatus, "Export failed: " + err.message, true);
    }
  }

  /** Used by the admin matcher to build a cohort straight from Firestore. */
  async function buildCohortFromFirestore() {
    await loadAdminBundle();
    const { projects, students } = await adminRosterReady();
    const hostTable = window.DpiCohort.objectsToTable(
      projectRows(projects),
      window.DpiCohort.HOST_COLUMNS
    );
    const studentTable = window.DpiCohort.objectsToTable(
      studentRows(students, projects),
      window.DpiCohort.STUDENT_COLUMNS
    );
    return window.DpiCohort.buildCohort(hostTable, studentTable);
  }

  async function signIn(role) {
    if (role) pendingRole = role;
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
  }

  async function signOut() {
    await auth.signOut();
    showView("landing");
  }

  async function requireSignInThen(view, role) {
    if (!authUser) {
      try {
        await signIn(role);
      } catch (err) {
        if (err.code !== "auth/popup-closed-by-user") {
          console.error(err);
          alert("Sign-in cancelled or failed: " + (err.message || err));
        }
        return;
      }
    }
    showView(view);
  }

  // ---------------------------------------------------------------------------
  // Boot — auth observer + click handlers. pendingRole is set before sign-in
  // so the first users/{uid} write gets student or host.
  // ---------------------------------------------------------------------------

  auth.onAuthStateChanged(async (user) => {
    authUser = user;
    hostProjectLoaded = false;
    hostProjectId = null;
    studentDocLoaded = false;
    studentDocId = null;
    projectCatalogLoaded = false;
    projectCatalog = [];
    studentChoices = [];
    setStudentDocuments({ resume: null, transcript: null });
    stopAdminListeners();

    if (!user) {
      userProfile = null;
      updateAuthUi();
      return;
    }

    try {
      userProfile = await ensureUserProfile(user);
    } catch (err) {
      console.error(err);
      userProfile = { role: "student", email: user.email || "" };
      alert("Could not load/create user profile: " + err.message);
    }
    updateAuthUi();

    if (currentView === "host") {
      loadHostProject().catch((err) => setHostStatus(err.message, true));
    }
    if (currentView.startsWith("apply")) {
      onEnterApplyView(currentView);
    }
    if (currentView === "admin" || currentView === "admin-project") {
      if (userProfile && userProfile.role === "admin") {
        startAdminListeners();
        if (currentView === "admin-project" && selectedAdminProjectId) {
          renderAdminProjectDetail(selectedAdminProjectId);
        }
      } else if (adminMeta) {
        adminMeta.textContent = "Admin access required.";
      }
    }
  });

  if (btnSignIn) {
    btnSignIn.addEventListener("click", () => {
      signIn().catch((err) => {
        if (err.code !== "auth/popup-closed-by-user") {
          alert("Sign-in failed: " + (err.message || err));
        }
      });
    });
  }
  if (btnSignOut) {
    btnSignOut.addEventListener("click", () => {
      signOut().catch((err) => alert(err.message));
    });
  }
  if (btnHostApp) {
    btnHostApp.addEventListener("click", () => showView("host"));
  }
  if (btnStudentApp) {
    btnStudentApp.addEventListener("click", () => showView("apply-1"));
  }
  if (btnAdminBoard) {
    btnAdminBoard.addEventListener("click", () => showView("admin"));
  }
  if (btnApplyHost) {
    btnApplyHost.addEventListener("click", () => requireSignInThen("host", "host"));
  }
  if (btnSaveDraft) {
    btnSaveDraft.addEventListener("click", () => {
      saveHostProject("draft").catch((err) => setHostStatus(err.message, true));
    });
  }
  if (hostForm) {
    hostForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveHostProject("submitted").catch((err) => setHostStatus(err.message, true));
    });
  }
  if (btnStudentSaveDraft) {
    btnStudentSaveDraft.addEventListener("click", () => {
      saveStudentApplication("draft").catch((err) =>
        setStudentReviewStatus(err.message, true)
      );
    });
  }
  if (btnStudentSubmit) {
    btnStudentSubmit.addEventListener("click", () => {
      saveStudentApplication("submitted").catch((err) =>
        setStudentReviewStatus(err.message, true)
      );
    });
  }

  STUDENT_DOC_TYPES.forEach((docType) => {
    const zone = uploadZone(docType);
    const input = zone && zone.querySelector('input[type="file"]');
    if (!zone || !input) return;

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      uploadStudentDocument(docType, file);
    });

    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
    zone.addEventListener("dragleave", () => {
      zone.classList.remove("is-dragging");
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
      const file = event.dataTransfer && event.dataTransfer.files[0];
      uploadStudentDocument(docType, file);
    });
  });

  (function bindHostLogoUpload() {
    const zone = uploadZone("logo");
    const input = zone && zone.querySelector('input[type="file"]');
    if (!zone || !input) return;

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      uploadHostLogo(file);
    });

    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
    zone.addEventListener("dragleave", () => {
      zone.classList.remove("is-dragging");
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
      const file = event.dataTransfer && event.dataTransfer.files[0];
      uploadHostLogo(file);
    });
  })();

  if (btnExportStudents) {
    btnExportStudents.addEventListener("click", () => exportWorkbook("students"));
  }
  if (btnExportHosts) {
    btnExportHosts.addEventListener("click", () => exportWorkbook("hosts"));
  }
  if (btnRefreshAdmin) {
    btnRefreshAdmin.addEventListener("click", () => {
      loadAdminRoster().catch((err) => {
        if (adminMeta) adminMeta.textContent = "Failed to load: " + err.message;
      });
    });
  }

  bindAdminStudentBoardDnD();

  const btnBackToProjects = document.getElementById("btn-back-to-projects");
  if (btnBackToProjects) {
    btnBackToProjects.addEventListener("click", () => {
      selectedAdminProjectId = null;
      showView("admin");
    });
  }

  if (adminList) {
    adminList.addEventListener("click", (event) => {
      const card = event.target.closest("[data-admin-project-id]");
      if (!card) return;
      openAdminProject(card.getAttribute("data-admin-project-id"));
    });
    adminList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-admin-project-id]");
      if (!card) return;
      event.preventDefault();
      openAdminProject(card.getAttribute("data-admin-project-id"));
    });
  }

  const adminProjectView = document.getElementById("view-admin-project");
  if (adminProjectView) {
    adminProjectView.addEventListener("click", (event) => {
      const assignBtn = event.target.closest("[data-assign-student]");
      if (assignBtn && selectedAdminProjectId) {
        const studentId = assignBtn.getAttribute("data-assign-student");
        assignStudentToProject(studentId, selectedAdminProjectId).catch((err) => {
          console.error(err);
          alert(err.message || "Could not assign intern.");
        });
        return;
      }

      const unassignBtn = event.target.closest("[data-unassign-student]");
      if (unassignBtn && selectedAdminProjectId) {
        const studentId = unassignBtn.getAttribute("data-unassign-student");
        if (!confirm("Remove this intern from the project?")) return;
        unassignStudentFromProject(studentId, selectedAdminProjectId).catch(
          (err) => {
            console.error(err);
            alert(err.message || "Could not unassign intern.");
          }
        );
        return;
      }

      const target = event.target.closest("button");
      if (!target || !selectedAdminProjectId) return;

      if (target.id === "apd-btn-approve") {
        setProjectReviewStatus("approved").catch((err) =>
          alert(err.message || "Could not approve project.")
        );
        return;
      }
      if (target.id === "apd-btn-request-changes") {
        setProjectReviewStatus("changes_requested").catch((err) =>
          alert(err.message || "Could not request changes.")
        );
        return;
      }
      if (target.id === "apd-btn-archive") {
        if (!confirm("Archive this project?")) return;
        setProjectReviewStatus("archived").catch((err) =>
          alert(err.message || "Could not archive project.")
        );
        return;
      }
      if (
        target.id === "apd-btn-top-match" ||
        target.id === "apd-btn-assign-interns" ||
        target.id === "apd-btn-assign-another"
      ) {
        const project = adminProjectsCache.find(
          (p) => p.id === selectedAdminProjectId
        );
        if (!project) return;
        const suggestions = suggestedMatchesForProject(
          project,
          adminStudentsCache,
          5
        );
        if (!suggestions.length) {
          alert("No submitted student applications available to assign.");
          return;
        }
        if (target.id === "apd-btn-assign-interns" || target.id === "apd-btn-assign-another") {
          const matchesEl = document.getElementById("apd-sidebar-matches");
          if (matchesEl) {
            matchesEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          return;
        }
        assignStudentToProject(
          suggestions[0].student.id,
          selectedAdminProjectId
        ).catch((err) => {
          console.error(err);
          alert(err.message || "Could not assign intern.");
        });
      }
    });
  }

  document.body.addEventListener("click", (event) => {
    const choiceBtn = event.target.closest("[data-choice] .pill");
    if (choiceBtn) {
      const group = choiceBtn.closest("[data-choice]");
      group.querySelectorAll(".pill").forEach((btn) => btn.classList.remove("is-active"));
      choiceBtn.classList.add("is-active");
      return;
    }

    const multiBtn = event.target.closest("[data-multi] .pill");
    if (multiBtn) {
      multiBtn.classList.toggle("is-active");
      return;
    }

    const skillLevelBtn = event.target.closest("[data-skill-choice] .pill");
    if (skillLevelBtn) {
      const group = skillLevelBtn.closest("[data-skill-choice]");
      const already = skillLevelBtn.classList.contains("is-active");
      group.querySelectorAll(".pill").forEach((btn) => btn.classList.remove("is-active"));
      if (!already) skillLevelBtn.classList.add("is-active");
      return;
    }

    const projectChoice = event.target.closest("[data-project-doc]");
    if (projectChoice) {
      toggleProjectChoice(projectChoice.getAttribute("data-project-doc"));
      return;
    }

    const checkItem = event.target.closest(
      "#host-deliverables .check-item, [data-check-multi] .check-item, #host-logo-consent.check-item"
    );
    if (checkItem) {
      checkItem.classList.toggle("is-checked");
      if (checkItem.hasAttribute("data-ack")) {
        checkItem.classList.toggle(
          "is-active",
          checkItem.classList.contains("is-checked")
        );
      }
      return;
    }

    const ackBtn = event.target.closest("[data-ack]");
    if (ackBtn) {
      ackBtn.classList.toggle("is-active");
      return;
    }

    const go = event.target.closest("[data-go]");
    if (!go) return;
    event.preventDefault();
    const target = go.getAttribute("data-go");
    if (target === "host") {
      requireSignInThen("host", "host");
      return;
    }
    // Only prompt on the way into the wizard, not when stepping back to step 1.
    if (target === "apply-1" && !currentView.startsWith("apply")) {
      requireSignInThen("apply-1", "student");
      return;
    }
    if (target === "admin") {
      if (!authUser || !userProfile || userProfile.role !== "admin") {
        alert("Admin access only. Sign in with an admin account.");
        return;
      }
      showView("admin");
      return;
    }
    showView(target);
  });

  const logo = document.querySelector(".logo");
  if (logo) {
    logo.addEventListener("click", () => showView("landing"));
  }

  window.DpiAdminData = { buildCohortFromFirestore, loadAdminBundle, backfillCatalog };
  window.__demoGo = showView;
  updateAuthUi();
})();
