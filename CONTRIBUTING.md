# Contributing Guidelines

Welcome to the project! This document outlines our standard operating procedures, repository architecture, and Git workflow. Please read this carefully to ensure your local environment and pull requests meet our professional standards.

---

## 1. Repository Architecture (3-Tier Environment)

We follow a structured environment promotion model to ensure code stability:

* **`dev`**: The active construction zone. All feature branches merge here.
* **`staging`**: The mirror of production. Used for final sign-off and integration testing.
* **`main`**: The live production code.

*(Optional)* **Release Branches (`release/vX.X`)**: Used to freeze features for a release while development continues on `dev`. Bugs found in staging are fixed on the release branch before final promotion.

---

## 2. Branch Protections & Governance

Our repository enforces strict branch protections on `dev`, `staging`, and `main`:
1.  **Require a Pull Request before merging**: No direct pushes allowed.
2.  **Require Signed Commits**: Every commit must be verified via GPG signature.
3.  **Require Status Checks to pass**: CI pipelines (like branch logic enforcement) must pass.
4.  **Require Review from Code Owners**: PRs modifying specific files must be approved by the designated `@owners` defined in `.github/CODEOWNERS`.

---

## 3. The Merge Strategy

To maintain a clean, readable, and verified Git history, we use specific merge strategies depending on the target branch:

| Merge Path | Strategy | Why? |
| :--- | :--- | :--- |
| **Feature $\rightarrow$ `dev`** | **Squash and Merge** | Keeps `dev` history atomic (one commit per feature), hides messy intermediate commits, and allows GitHub to automatically sign the final bundled commit. |
| **`dev` $\rightarrow$ `staging`** | **Rebase and Merge** | Promotes the exact, clean history from `dev` directly into `staging`. |
| **`staging` $\rightarrow$ `main`** | **Rebase and Merge** | Ensures `main` matches `staging` exactly. |

*Note: Set your GitHub Squash merge message preference to "Pull request title and description" to ensure context is preserved in the commit body.*

---

## 4. Daily Developer Workflow

Follow this 7-step routine for every new feature or fix:

1.  **Sync your local environment:**
    ```bash
    git switch dev
    git pull origin dev
    ```
2.  **Create a feature branch:**
    ```bash
    git switch -c feature/your-feature-name
    ```
3.  **Code and Commit (Signed):** Ensure your commits are GPG signed.
4.  **Push and track the remote branch:**
    ```bash
    git push -u origin feature/your-feature-name
    ```
5.  **Open a Pull Request:** Ensure the PR title is concise (e.g., `feat: add login`) and the description contains the *why*.
6.  **Merge:** Once approved and checks pass, click **Squash and Merge** on GitHub.
7.  **Clean up your local environment:**
    ```bash
    git switch dev
    git pull origin dev
    git branch -D feature/your-feature-name  # Use capital -D because the squash changed the commit ID
    ```

---

## 5. Setup & Troubleshooting: GPG + VS Code (Mac)

Because we require signed commits, you must have GPG configured. If you use VS Code, the integrated "Commit" button often fails (`gpg failed to sign the data`) because GPG tries to prompt for a password in a hidden terminal.

**The Fix (Mac OS):**

1.  **Install Pinentry for Mac:**
    ```bash
    brew install pinentry-mac
    ```
2.  **Find the installation path:**
    ```bash
    which pinentry-mac
    # Usually outputs: /opt/homebrew/bin/pinentry-mac OR /usr/local/bin/pinentry-mac
    ```
3.  **Configure GPG Agent:**
    Open `~/.gnupg/gpg-agent.conf` and ensure it contains ONLY this line (use your exact path from step 2):
    ```text
    pinentry-program /opt/homebrew/bin/pinentry-mac
    ```
4.  **Configure Git to use your explicit GPG binary:**
    ```bash
    git config --global gpg.program $(which gpg)
    ```
5.  **Restart the GPG Agent:**
    ```bash
    gpgconf --kill gpg-agent
    ```
6.  **Test and Save to Keychain:**
    Run the following in your terminal:
    ```bash
    echo "test" | gpg --clearsign
    ```
    A Mac popup window should appear. Enter your GPG password, check **"Save in Keychain"**, and click OK. VS Code will now be able to sign commits silently in the background!
