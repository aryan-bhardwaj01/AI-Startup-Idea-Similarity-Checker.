console.log("JavaScript connected");

const titleInput = document.getElementById("startup-title");
const descriptionInput = document.getElementById("startup-description");
const domainInput = document.getElementById("select-domain");
const form = document.getElementById("startup-form");
const errorBox = document.getElementById("error-box");
const resultsSection = document.getElementById("results-section");
const analyzeButton = form
    ? form.querySelector('button[type="submit"]')
    : null;
const analyzeButtonLabel = document.getElementById("analyze-button-label");
const descriptionCount = document.getElementById("description-count");

// Collect the user's input from the form.
function getFormData() {
    return {
        titleData: titleInput.value.trim(),
        descriptionData: descriptionInput.value.trim(),
        domainData: domainInput.value.trim()
    };
}

// Validate the form before sending data to the server.
function validateData(data) {
    if (!data.titleData || !data.descriptionData || !data.domainData) {
        return "Please fill in all required fields.";
    }

    if (data.descriptionData.length < 40) {
        return "Please provide a more detailed description (at least 40 characters).";
    }

    if (data.descriptionData.length > 1000) {
        return "Please keep your description within 1,000 characters.";
    }

    return null;
}

// Display or hide the error message.
function showError(message) {
    if (!errorBox) return;

    if (message) {
        errorBox.textContent = message;
        errorBox.style.display = "block";
    } else {
        errorBox.textContent = "";
        errorBox.style.display = "none";
    }
}

// Update the live character counter.
function updateCharacterCount() {
    if (!descriptionInput || !descriptionCount) return;

    const length = descriptionInput.value.length;

    descriptionCount.textContent =
        `${length.toLocaleString()} / 1,000`;

    descriptionCount.classList.toggle(
        "near-limit",
        length >= 900
    );
}

// Update the button while the analysis is running.
function setLoading(isLoading) {
    if (analyzeButton) {
        analyzeButton.disabled = isLoading;
        analyzeButton.setAttribute(
            "aria-busy",
            String(isLoading)
        );
    }

    if (analyzeButtonLabel) {
        analyzeButtonLabel.textContent = isLoading
            ? "Analyzing..."
            : "Analyze idea";
    } else if (analyzeButton) {
        analyzeButton.textContent = isLoading
            ? "Analyzing..."
            : "Analyze idea";
    }
}

// Convert the novelty score into a readable label.
function noveltyLabel(score) {
    if (score <= 30) return "Crowded space";
    if (score <= 60) return "Some competition";

    return "Fairly novel";
}

// Only accept normal HTTP and HTTPS links.
function isSafeUrl(url) {
    return typeof url === "string"
        && /^https?:\/\//i.test(url.trim());
}

// Create HTML elements safely using textContent.
function makeEl(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (text !== undefined && text !== null) {
        element.textContent = String(text);
    }

    return element;
}

// Keep numerical values within a specified range.
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// Fill the meters after the first paint so the CSS width transition can animate them.
function animateMeters() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            resultsSection.querySelectorAll(".meter-fill").forEach((fill) => {
                fill.style.width = fill.dataset.width || "0%";
            });
        });
    });
}

// Display the analysis summary and matching startups.
function renderResults(result) {
    if (!result || !Array.isArray(result.matches)) {
        throw new Error("Unexpected reply from server");
    }

    const rawNoveltyScore = Number(result.noveltyScore);

    if (!Number.isFinite(rawNoveltyScore)) {
        throw new Error(
            "The server did not return a valid novelty score"
        );
    }

    const noveltyScore = clamp(rawNoveltyScore, 0, 100);

    resultsSection.replaceChildren();

    // Create the main novelty summary.
    const summary = makeEl("div", "result-summary");

    const scoreBlock = makeEl("div", "score-block");

    scoreBlock.appendChild(
        makeEl(
            "div",
            "novelty-score",
            Math.round(noveltyScore)
        )
    );

    scoreBlock.appendChild(
        makeEl("div", "score-outof", "out of 100")
    );

    summary.appendChild(scoreBlock);

    // Add the score label, meter, and explanation.
    const info = makeEl("div", "summary-info");

    info.appendChild(
        makeEl(
            "div",
            "novelty-label",
            noveltyLabel(noveltyScore)
        )
    );

    const meter = makeEl("div", "meter");
    const fill = makeEl("div", "meter-fill");

    fill.dataset.width = `${noveltyScore}%`;

    meter.appendChild(fill);
    info.appendChild(meter);

    const scale = makeEl("div", "meter-scale");

    scale.appendChild(makeEl("span", "", "Crowded"));
    scale.appendChild(makeEl("span", "", "Novel"));

    info.appendChild(scale);

    info.appendChild(
        makeEl(
            "div",
            "novelty-caption",
            "Higher scores indicate that fewer startups in the available Y Combinator dataset closely resemble your idea. This is an estimate, so review the matches below and do further research."
        )
    );

    // Say "no close match" only when BOTH are true, so it never contradicts the score:
    //  - the novelty score is 50 or more (so the label is never "Crowded space"), and
    //  - no returned startup reaches 0.55 similarity. We use the highest similarity among
    //    the cards, because the domain boost can put a less similar startup first.
    if (result.matches.length > 0) {
        const closestSimilarity = Math.max(
            ...result.matches.map((m) => Number(m.similarity))
        );

        if (
            Number.isFinite(closestSimilarity)
            && closestSimilarity < 0.55
            && noveltyScore >= 50
        ) {
            info.appendChild(
                makeEl(
                    "div",
                    "weak-note",
                    "No close match was found in this dataset. The startups below may be only loosely related to your idea."
                )
            );
        }
    }

    summary.appendChild(info);
    resultsSection.appendChild(summary);

    // Handle a response that contains no matching startups.
    if (result.matches.length === 0) {
        resultsSection.appendChild(
            makeEl(
                "h3",
                "results-heading",
                "No similar startups were returned"
            )
        );

        resultsSection.appendChild(
            makeEl(
                "p",
                "match-description",
                "Try making your description more specific and analyze the idea again."
            )
        );

        animateMeters();

        resultsSection.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });

        return;
    }

    // Create the matching startup cards.
    resultsSection.appendChild(
        makeEl(
            "h3",
            "results-heading",
            "Most similar startups"
        )
    );

    resultsSection.appendChild(
        makeEl(
            "p",
            "rank-note",
            "Ranked by similarity plus a small bonus for startups in your chosen domain, so the order can differ slightly from the similarity values shown."
        )
    );

    const grid = makeEl("div", "cards-grid");

    result.matches.forEach((match, index) => {
        grid.appendChild(buildCard(match, index + 1));
    });

    resultsSection.appendChild(grid);

    animateMeters();

    // Bring the results into view after rendering.
    resultsSection.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

// Build an individual startup result card.
function buildCard(match, rank) {
    const card = makeEl(
        "article",
        rank === 1 ? "match-card top" : "match-card"
    );

    // Rank and startup name.
    const top = makeEl("div", "match-top");

    top.appendChild(
        makeEl("span", "rank", rank)
    );

    const startupName =
        match && match.name
            ? String(match.name)
            : "Unnamed startup";

    let nameElement;

    if (isSafeUrl(match && match.url)) {
        nameElement = makeEl(
            "a",
            "match-name",
            startupName
        );

        nameElement.href = match.url.trim();
        nameElement.target = "_blank";
        nameElement.rel = "noopener noreferrer";
    } else {
        nameElement = makeEl(
            "span",
            "match-name",
            startupName
        );
    }

    top.appendChild(nameElement);
    card.appendChild(top);

    // Similarity meter and numerical score.
    const similarity = clamp(
        Number(match && match.similarity) || 0,
        0,
        1
    );

    const simRow = makeEl("div", "sim-row");
    const meter = makeEl("div", "meter");
    const fill = makeEl("div", "meter-fill");

    fill.dataset.width =
        `${Math.round(similarity * 100)}%`;

    meter.appendChild(fill);
    simRow.appendChild(meter);

    simRow.appendChild(
        makeEl(
            "span",
            "match-score",
            `Similarity ${similarity.toFixed(2)}`
        )
    );

    card.appendChild(simRow);

    // Startup description.
    card.appendChild(
        makeEl(
            "p",
            "match-description",
            match && match.description
                ? match.description
                : "No description is available for this startup."
        )
    );

    // Status, industry, and additional information.
    const meta = makeEl("div", "match-meta");

    const status =
        match && match.status
            ? String(match.status)
            : "Unknown";

    const statusClass = status
        .toLowerCase()
        .replace(/[^a-z]/g, "");

    meta.appendChild(
        makeEl(
            "span",
            `badge badge-${statusClass}`,
            status
        )
    );

    if (match && match.subIndustry) {
        meta.appendChild(
            makeEl("span", "", match.subIndustry)
        );
    }

    if (status.toLowerCase() === "inactive") {
        meta.appendChild(
            makeEl("span", "", "No longer active")
        );
    }

    card.appendChild(meta);

    return card;
}

// Sample startup ideas for the example buttons.
const exampleIdeas = {
    food: {
        title: "QuickBite",
        description:
            "QuickBite helps students and busy professionals order affordable meals from nearby restaurants, with scheduled delivery and transparent pricing.",
        domain: "e-commerce"
    },

    education: {
        title: "StudyBuddy",
        description:
            "StudyBuddy helps students master difficult subjects through peer study groups, personalized revision plans, practice questions, and progress tracking.",
        domain: "education"
    },

    environment: {
        title: "OilLoop",
        description:
            "OilLoop collects used cooking oil from restaurants and households and connects it with recycling partners to turn waste into reusable industrial materials.",
        domain: "environment"
    }
};

// Keep the character counter updated as the user types.
if (descriptionInput) {
    descriptionInput.addEventListener(
        "input",
        updateCharacterCount
    );

    updateCharacterCount();
}

// ---------- AI Insight ----------
// A button under the results asks the server (POST /api/insight) to explain the matches.
// The server calls the LLM, so the API key never reaches the browser.
const INSIGHT_PARTS = [
    ["whySimilar", "Why these startups are similar"],
    ["howToDiffer", "How your idea can stand apart"],
    ["noveltyTip", "One tip to raise your novelty score"]
];

function renderInsightPanel(formData, result) {
    if (!result || !Array.isArray(result.matches) || result.matches.length === 0) return;

    const panel = makeEl("section", "insight-panel");
    panel.setAttribute("aria-label", "AI Insight");

    const head = makeEl("div", "insight-head");
    head.appendChild(makeEl("span", "insight-spark", "✦"));

    const titles = makeEl("div", "insight-titles");
    titles.appendChild(makeEl("h3", "insight-title", "AI Insight"));
    titles.appendChild(makeEl(
        "p",
        "insight-sub",
        "Get a short plain-English explanation of these results and how to make your idea stand out."
    ));
    head.appendChild(titles);

    const button = makeEl("button", "insight-btn", "Generate AI insight");
    button.type = "button";
    head.appendChild(button);

    const body = makeEl("div", "insight-body");
    body.setAttribute("aria-live", "polite");

    panel.appendChild(head);
    panel.appendChild(body);
    resultsSection.appendChild(panel);

    let busy = false;

    button.addEventListener("click", async function () {
        if (busy) return;
        busy = true;
        button.disabled = true;
        button.textContent = "Thinking...";
        body.className = "insight-body is-loading";
        body.replaceChildren(makeEl("p", "insight-status", "Reading the matches and writing your insight..."));

        try {
            const response = await fetch("/api/insight", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: formData.titleData,
                    description: formData.descriptionData,
                    domain: formData.domainData,
                    noveltyScore: result.noveltyScore,
                    matches: result.matches
                })
            });

            if (!response.ok) {
                const err = await response.json().catch(() => null);
                throw new Error(err && err.error ? err.error : "The insight request failed.");
            }

            const data = await response.json();

            // The user may have run a new analysis while we waited.
            if (!panel.isConnected) return;

            body.className = "insight-body";
            body.replaceChildren();

            INSIGHT_PARTS.forEach(function (part) {
                if (typeof data[part[0]] !== "string" || !data[part[0]]) return;
                const block = makeEl("div", "insight-block");
                block.appendChild(makeEl("h4", "insight-block-title", part[1]));
                block.appendChild(makeEl("p", "insight-text", data[part[0]]));
                body.appendChild(block);
            });

            const isAi = data.source === "ai";
            body.appendChild(makeEl(
                "p",
                isAi ? "insight-foot" : "insight-foot is-fallback",
                isAi
                    ? "Written by AI from your idea and the matches above. AI can make mistakes, so use it as a starting point."
                    : (data.reason || "This is a rule-based summary.") + (data.noKey ? " Add an API key to the .env file to get AI-written insight." : " Please try again in a moment.")
            ));

            button.textContent = "Regenerate";
        } catch (error) {
            console.error("AI Insight failed:", error);
            if (!panel.isConnected) return;
            body.className = "insight-body";
            body.replaceChildren(makeEl(
                "p",
                "insight-status is-error",
                (error && error.message ? error.message : "Could not get the insight.") + " Please try again."
            ));
            button.textContent = "Try again";
        } finally {
            busy = false;
            button.disabled = false;
        }
    });
}

// Handle form submission and communicate with the backend.
if (form) {
    form.addEventListener("submit", async function (event) {
        event.preventDefault();

        const formData = getFormData();
        const errorMessage = validateData(formData);

        if (errorMessage) {
            showError(errorMessage);
            return;
        }

        showError(null);
        resultsSection.replaceChildren();

        setLoading(true);

        try {
            const response = await fetch("/api/analyze", {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    title: formData.titleData,
                    description: formData.descriptionData,
                    domain: formData.domainData
                })
            });

            if (!response.ok) {
                const responseBody =
                    await response.json().catch(() => null);

                const message =
                    response.status === 400
                    && responseBody
                    && responseBody.error
                        ? responseBody.error
                        : "Something went wrong. Please try again.";

                showError(message);
                return;
            }

            const result = await response.json();

            renderResults(result);
            renderInsightPanel(formData, result);

        } catch (error) {
            console.error(
                "Startup analysis failed:",
                error
            );

            showError(
                "Could not complete the analysis. Check that the server is running, then try again."
            );

        } finally {
            setLoading(false);
        }
    });
}

// ---------- Upload a description from a file (.txt, .md or .pdf) ----------
// Everything happens in the browser. Nothing is sent to the server until you press
// Analyze, and the same validation as typed text still applies.
const MAX_DESCRIPTION = 1000;            // keep in sync with the textarea maxlength
const MAX_TEXT_BYTES = 200 * 1024;       // 200 KB is far more than 1,000 characters needs
const MAX_PDF_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_PDF_PAGES = 10;                // we only need the first ~1,000 characters

const fileInput = document.getElementById("idea-file");
const uploadTrigger = document.getElementById("upload-trigger");
const uploadStatus = document.getElementById("upload-status");

// Each upload gets a number. If you pick a second file while the first is still being
// read, the older one notices it is out of date and stops instead of overwriting.
let uploadToken = 0;

function setUploadStatus(message, kind) {
    if (!uploadStatus) return;

    uploadStatus.textContent = message || "";
    uploadStatus.className = kind
        ? `upload-status is-${kind}`
        : "upload-status";
}

// Decide what kind of file this is from its name (type is often empty for .md).
function fileKind(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith(".pdf") || file.type === "application/pdf") {
        return "pdf";
    }

    if (
        /\.(txt|md|markdown)$/.test(name)
        || file.type === "text/plain"
        || file.type === "text/markdown"
    ) {
        return "text";
    }

    return null;
}

// pdf.js is about 1.8 MB, so it is only downloaded the first time someone picks a PDF.
// The files live in public/vendor/pdfjs, so this works offline too.
let pdfjsPromise = null;

function loadPdfJs() {
    if (!pdfjsPromise) {
        pdfjsPromise = import("./vendor/pdfjs/pdf.min.mjs")
            .then(function (lib) {
                lib.GlobalWorkerOptions.workerSrc = new URL(
                    "./vendor/pdfjs/pdf.worker.min.mjs",
                    document.baseURI
                ).href;
                return lib;
            })
            .catch(function (error) {
                pdfjsPromise = null;   // allow another attempt next time

                // Turn the browser's vague "failed to fetch module" into something we can explain.
                const missing = new Error("The PDF reader files could not be loaded");
                missing.name = "PdfLibraryMissing";
                missing.cause = error;
                throw missing;
            });
    }

    return pdfjsPromise;
}

// Read the text out of the first pages of a PDF.
async function extractPdfText(file) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());

    // isEvalSupported:false switches off a pdf.js feature that is not needed here
    // and that has been abused by hostile PDFs in the past.
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

    try {
        let text = "";
        const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);

        for (let n = 1; n <= pages && text.length <= MAX_DESCRIPTION; n++) {
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();

            text += content.items
                .map((item) => (item.str || "") + (item.hasEOL ? " " : ""))
                .join("") + " ";
        }

        // PDFs break lines wherever the layout needs, so flatten all whitespace.
        return text.replace(/\s+/g, " ").trim();
    } finally {
        pdf.destroy();
    }
}

function uploadErrorMessage(error, kind) {
    if (kind === "pdf") {
        // The worker file is loaded later than the main file, so check its error text too.
        if (error && (error.name === "PdfLibraryMissing" || /worker/i.test(String(error.message)))) {
            return "PDF reader files not found. Check that public/vendor/pdfjs/ contains pdf.min.mjs and pdf.worker.min.mjs (same spelling), then reload with Ctrl+F5.";
        }

        if (error && error.name === "PasswordException") {
            return "That PDF is password-protected. Remove the password and try again.";
        }

        if (error && error.name === "InvalidPDFException") {
            return "That does not look like a valid PDF. It may be damaged or renamed from another file type.";
        }

        return "Could not read that PDF. Try another file, or paste the text instead.";
    }

    return "Could not read that file. Please try again.";
}

// Put the extracted text into the box, with the 1,000 character limit applied.
function applyUploadedText(rawText, fileName, kind) {
    let text = rawText
        .replace(/^\uFEFF/, "")        // invisible byte-order mark some editors add
        .replace(/\r\n?/g, "\n")
        .trim();

    if (!text) {
        setUploadStatus(
            kind === "pdf"
                ? "No selectable text found. Scanned or image-only PDFs are not supported, so paste the text instead."
                : "That file is empty.",
            "error"
        );
        return;
    }

    if (text.includes("\u0000")) {
        setUploadStatus("That does not look like a plain text file.", "error");
        return;
    }

    const wasCut = text.length > MAX_DESCRIPTION;

    if (wasCut) {
        text = text.slice(0, MAX_DESCRIPTION);
    }

    descriptionInput.value = text;
    updateCharacterCount();
    showError(null);

    setUploadStatus(
        wasCut
            ? `Loaded "${fileName}". Only the first ${MAX_DESCRIPTION.toLocaleString()} characters fit, so please check it before analyzing.`
            : `Loaded "${fileName}" (${text.length.toLocaleString()} characters). You can still edit it.`,
        wasCut ? "warn" : "ok"
    );
}

async function loadDescriptionFile(file) {
    if (!file) return;

    const kind = fileKind(file);

    if (!kind) {
        setUploadStatus("Only .txt, .md or .pdf files are supported.", "error");
        return;
    }

    const isPdf = kind === "pdf";

    if (file.size > (isPdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES)) {
        setUploadStatus(
            `That file is too large (${isPdf ? "5 MB" : "200 KB"} max). Paste the key part of your idea instead.`,
            "error"
        );
        return;
    }

    const token = ++uploadToken;
    setUploadStatus(isPdf ? "Reading PDF..." : "Reading file...");

    try {
        const rawText = isPdf
            ? await extractPdfText(file)
            : await file.text();

        if (token !== uploadToken) return;   // a newer upload has started

        applyUploadedText(rawText, file.name, kind);
    } catch (error) {
        if (token !== uploadToken) return;

        console.error("File upload failed:", error);
        setUploadStatus(uploadErrorMessage(error, kind), "error");
    }
}

if (fileInput && uploadTrigger) {
    uploadTrigger.addEventListener("click", function () {
        fileInput.click();
    });

    fileInput.addEventListener("change", function () {
        loadDescriptionFile(fileInput.files[0]);
        fileInput.value = "";   // lets you pick the same file again later
    });
}

// Drag a file onto the text box. Plain text drags still work as normal.
function dragHasFiles(event) {
    return event.dataTransfer
        && Array.from(event.dataTransfer.types || []).includes("Files");
}

if (descriptionInput) {
    ["dragenter", "dragover"].forEach(function (type) {
        descriptionInput.addEventListener(type, function (event) {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            descriptionInput.classList.add("is-dragover");
        });
    });

    ["dragleave", "dragend", "drop"].forEach(function (type) {
        descriptionInput.addEventListener(type, function () {
            descriptionInput.classList.remove("is-dragover");
        });
    });

    descriptionInput.addEventListener("drop", function (event) {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        loadDescriptionFile(event.dataTransfer.files[0]);
    });
}

// Make the example buttons populate the form.
document
    .querySelectorAll(".example-chip[data-example]")
    .forEach((button) => {
        button.addEventListener("click", function () {
            const example =
                exampleIdeas[button.dataset.example];

            if (!example) return;

            titleInput.value = example.title;
            descriptionInput.value = example.description;
            domainInput.value = example.domain;

            updateCharacterCount();
            showError(null);
            resultsSection.replaceChildren();

            descriptionInput.focus();
        });
    });
