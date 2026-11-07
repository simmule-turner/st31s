const fs = require('fs');
const path = require('path');

// Adjust imports based on your local directory structure
// dcmath.js / dcengine.js are plain browser scripts (no module.exports), so evaluate them together.
const SRC = process.env.DC_SRC || path.join(__dirname, '..');
const loaded = new (require('module').Module)('dc');
loaded._compile(fs.readFileSync(path.join(SRC, 'dcmath.js'), 'utf8') + '\n' +
                fs.readFileSync(path.join(SRC, process.env.DC_ENGINE || 'dcengine.js'), 'utf8') +
                '\nmodule.exports = { DCMath, DCEngine };', 'dc.js');
const { DCEngine, DCMath } = loaded.exports;

const TEST_FILE_NAME = 'DCTestsData';

/**
 * Normalizes strings by stripping all newlines and replacing them with a single space.
 * This guarantees there are no newlines in the final compared or displayed output.
 */
function normalizeOutput(str) {
  if (!str) return '';
  return str
    .toString()
    .replace(/[\r\n]+/g, ' ')  // Strip all newlines and replace with a single space
    .replace(/\s+/g, ' ')      // Collapse any resulting consecutive spaces
    .trim();
}

/**
 * Parses the custom pipe-delimited test file format, 
 * factoring in multi-line expected output continuations.
 */
function parseDCTests(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const tests = [];
  let currentTest = null;

  for (let line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }

    if (line.includes('|')) {
      const parts = line.split('|');
      if (parts.length >= 2) {
        currentTest = {
          name: parts[0].trim(),
          command: parts[1].trim(),
          expected: parts[2] ? parts[2].trimRight() : ''
        };
        tests.push(currentTest);
      }
    } else {
      // Line continuation for multi-line expected outputs
      if (currentTest) {
        currentTest.expected += ' ' + line.trim();
      }
    }
  }

  return tests;
}

function runTestSuite() {
  const filePath = path.join(__dirname, TEST_FILE_NAME);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: Test file "${TEST_FILE_NAME}" not found at: ${filePath}`);
    process.exit(1);
  }

  console.log(`Parsing and executing tests from ${TEST_FILE_NAME}...\n`);
  const tests = parseDCTests(filePath);

  let passed = 0;
  let failed = 0;
  const failureLog = [];

  tests.forEach((test) => {
    // Isolated state environment per test row
    let state = { stack: [], registers: Object.create(null), config: { i: 10, o: 10, k: 0 } };
    const mockEnv = {
      DCMath: DCMath,
      loadState: () => state,
      saveState: (updated) => { state = updated; }
    };

    try {
      const engine = new DCEngine(mockEnv);
      const rawActualOutput = engine.run(test.command);

      // Apply the strict newline-stripping normalization rule
      const actualNormalized = normalizeOutput(rawActualOutput);
      const expectedNormalized = normalizeOutput(test.expected);

      if (actualNormalized === expectedNormalized) {
        passed++;
      } else {
        failed++;
        failureLog.push({
          name: test.name,
          command: test.command,
          expected: expectedNormalized,
          actual: actualNormalized
        });
      }
    } catch (err) {
      failed++;
      failureLog.push({
        name: test.name,
        command: test.command,
        expected: normalizeOutput(test.expected),
        actual: `CRASH: ${err.message}`
      });
    }
  });

  // Display Test Summary Dashboard
  console.log('==================================================');
  console.log('            DC ENGINE TEST RUNNER REPORT          ');
  console.log('==================================================');
  console.log(`Total Executed : ${passed + failed}`);
  console.log(`Passed         : \x1b[32m${passed}\x1b[0m`);
  console.log(`Failed         : ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : '0'}`);
  console.log('==================================================\n');

  if (failureLog.length > 0) {
    console.log('\x1b[31mDetailed Failure Diagnostics (Flattened Space-Separated):\x1b[0m');
    failureLog.forEach((fail) => {
      console.log(`\n❌ [FAIL] Suite: ${fail.name}`);
      console.log(`   Command  : ${fail.command}`);
      console.log(`   Expected : [${fail.expected}]`);
      console.log(`   Actual   : [${fail.actual}]`);
      console.log('-'.repeat(50));
    });
    process.exit(1);
  } else {
    console.log('\x1b[32m✔ All tests passed successfully with flattened normalization!\x1b[0m\n');
    process.exit(0);
  }
}

runTestSuite();
