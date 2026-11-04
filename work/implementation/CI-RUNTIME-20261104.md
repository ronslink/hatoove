# Runtime regressions exposed by scheduled browser checks

Execution `CI-RUNTIME-20261104-A`, coordinator author, [issue181](https://github.com/ronslink/hatoove/issues/181), source base `6f4f84ca749e335cc77534bcfd6e3094bafcf233`. These corrections are independent of the DTZ legal amendment.

- A successful preparation switch now unmounts the previous module before selecting the new preparation. This invalidates pending view work and prevents `route()` from treating an old mounted screen as already current, skipping the unsupported-section redirect.
- Successful part grading refreshes the owned mistake count immediately. A failed count read preserves the completed review and prior badge; a late response cannot repaint an unmounted/new preparation. The server's total takes precedence over a partial item list.
- Mobile navigation labels can wrap within their grid columns, including long translated labels. Existing font size, tap targets, icons and five-column layout are retained. Reference inspected: `D:\Hatoove\design\assets\hatoove.css` and `screens/dashboard.html`, under DESIGN-WIRE-01.

Focused validation: the added badge tests first failed against the original runner in the success and late-response legs, then passed after the correction. `practice-runner-check`48/48, `shell-locale-check`25/25, `practice-locale-check`18/18, `design-check`14/14 and `i18n-register-check` pass. Browser reproduction already demonstrated the unsupported-view and mobile overflow failures; integrated desktop/mobile green evidence and independent review remain pending. Viewport evidence does not replace physical iPhone/Android keyboard/audio acceptance.

The separate opt-in DTZ tile metadata defect is tracked as [issue182](https://github.com/ronslink/hatoove/issues/182); this slice does not claim to fix it. Existing canonical dirty work, learner records and production remain unchanged.
