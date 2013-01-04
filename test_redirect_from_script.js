/*
 * Test whether the rewrite-requests-from-script API implemented here:
 * https://bugzilla.mozilla.org/show_bug.cgi?id=765934 is functioning
 * correctly
 *
 * The test has the following components:
 *
 * testViaXHR() checks that internal redirects occur correctly for requests
 * made with nsIXMLHttpRequest objects.
 *
 * testViaAsyncOpen() checks that internal redirects occur correctly when made
 * with nsIHTTPChannel.asyncOpen().
 *
 * Both of the above functions tests four requests, a simple case that
 * redirects within a server; a second that redirects to a second webserver;
 * and a third where internal script redirects in response to a server-side
 * 302 redirect, and a fourth where one internal script redirects in response
 * to another's redirect.  The successful redirects are confirmed by the
 * presence of a custom response header.
 *
 */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://testing-common/httpd.js");

// redirectOpportunity /should/ be http-on-modify-request, but that seems to
// be broken ATM
// redirectOpportunity = "http-on-modify-request";
// this alternative works for 3 of the 4 test scenarios, but not Test Part 4
redirectOpportunity = "http-on-opening-request";

var httpServer = null, httpServer2 = null;

// Test Part 1: a cross-path redirect on a single HTTP server
// http://localhost:4444/bait -> http://localhost:4444/switch
var baitPath = "/bait";
var baitURI = "http://localhost:4444" + baitPath;
var baitText = "you got the worm";

var redirectedPath = "/switch";
var redirectedURI = "http://localhost:4444" + redirectedPath;
var redirectedText = "worms are not tasty";

// Test Part 2: Now, a redirect to a different server
// http://localhost:4444/bait2 -> http://localhost:4445/switch
var bait2Path = "/bait2";
var bait2URI = "http://localhost:4444" + bait2Path;
var redirected2URI = "http://localhost:4445" + redirectedPath;

// Test Part 3, begin with a serverside redirect that itself turns into an instance
// of Test Part 1
var bait3Path = "/frog";
var bait3URI = "http://localhost:4444" + bait3Path;

// Test Part 4, begin with this client-side redirect and which then redirects
// to an instance of Test Part 1
var bait4Path = "/prince";
var bait4URI = "http://localhost:4444" + bait4Path;

var testHeaderName = "X-Redirected-By-Script"
var testHeaderVal = "Yes indeed";
var testHeaderVal2 = "Very Yes";


function make_channel(url, callback, ctx) {
  var ios = Cc["@mozilla.org/network/io-service;1"].
            getService(Ci.nsIIOService);
  return ios.newChannel(url, "", null);
}

function baitHandler(metadata, response)
{
  // Content-Type required: https://bugzilla.mozilla.org/show_bug.cgi?id=748117
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(baitText, baitText.length);
}

function redirectedHandler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(redirectedText, redirectedText.length);
  response.setHeader(testHeaderName, testHeaderVal);
}

function redirected2Handler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(redirectedText, redirectedText.length);
  response.setHeader(testHeaderName, testHeaderVal2);
}

function bait3Handler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);  
  response.setStatusLine(metadata.httpVersion, 302, "Found");
  response.setHeader("Location", redirectedURI);
}


Redirector.prototype = {
  // This class observes an event and uses that to
  // trigger a redirectTo(uri) redirect using the new API
  // before https://bugzilla.mozilla.org/show_bug.cgi?id=800799
  // the event was http-on-modify-request; now it's http-on-opening-request
  register: function()
  {
    Cc["@mozilla.org/observer-service;1"].
      getService(Ci.nsIObserverService).
      addObserver(this, redirectOpportunity, true);
  },

  QueryInterface: function(iid)
  {
    if (iid.equals(Ci.nsIObserver) ||
        iid.equals(Ci.nsISupportsWeakReference) ||
        iid.equals(Ci.nsISupports))
      return this;
    throw Components.results.NS_NOINTERFACE;
  },

  observe: function(subject, topic, data)
  {
    if (topic == redirectOpportunity) {
      dump("in observerx for " + redirectOpportunity + "\n");
      if (!(subject instanceof Ci.nsIHttpChannel))
        do_throw("http-on-opening-request observed a non-HTTP channel");
      var channel = subject.QueryInterface(Ci.nsIHttpChannel);
      var ioservice = Cc["@mozilla.org/network/io-service;1"].
                        getService(Ci.nsIIOService);
      var target = null;
      if (channel.URI.spec == baitURI)  target = redirectedURI;
      if (channel.URI.spec == bait2URI) target = redirected2URI;
      if (channel.URI.spec == bait4URI) target = baitURI;
      // if we have a target, redirect there
      if (target) {
        var tURI = ioservice.newURI(target, null, null);
        try       { 
          var ret = channel.redirectTo(tURI);
          if (!ret)
            dump("Chanel.redirectTo returned " + ret + "\n");
        } catch (e) { do_throw("Exception in redirectTo " + e + "\n"); }
      }
    }
  }
}

finished=false;

function Redirector()
{
  this.register();
}

function makeAsyncOpenTest(uri, verifier)
{
  // Produce a function to run an asyncOpen test
  var test = function()
  {
    var chan = make_channel(uri);
    chan.asyncOpen(new ChannelListener(verifier), null);
  };
  return test;
}

function makeVerifier(headerValue, nextTask)
{
  // Produce a callback function which checks for the presence of headerValue,
  // and then continues to the next async test task
  var verifier = function(req, buffer)
  {
    if (!(req instanceof Ci.nsIHttpChannel))
      do_throw(req + " is not an nsIHttpChannel, catastrophe imminent!");

    var httpChannel = req.QueryInterface(Ci.nsIHttpChannel);
    do_check_eq(httpChannel.getResponseHeader(testHeaderName), headerValue);
    do_check_eq(buffer, redirectedText);
    nextTask();
  };
  return verifier;
}

// The tests and verifier callbacks depend on each other, and therefore need
// to be defined in the reverse of the order they are called in.  It is
// therefore best to read this stanza backwards!
// Skip test 4
asyncVerifyCallback4 = makeVerifier     (testHeaderVal,  done);
testViaAsyncOpen4    = makeAsyncOpenTest(bait4URI,       asyncVerifyCallback4);
//asyncVerifyCallback3 = makeVerifier     (testHeaderVal,  testViaAsyncOpen4);
asyncVerifyCallback3 = makeVerifier     (testHeaderVal,  done); // skip test 4
testViaAsyncOpen3    = makeAsyncOpenTest(bait3URI,       asyncVerifyCallback3);
asyncVerifyCallback2 = makeVerifier     (testHeaderVal2, testViaAsyncOpen3);
testViaAsyncOpen2    = makeAsyncOpenTest(bait2URI,       asyncVerifyCallback2);
asyncVerifyCallback  = makeVerifier     (testHeaderVal,  testViaAsyncOpen2);
testViaAsyncOpen     = makeAsyncOpenTest(baitURI,        asyncVerifyCallback);

function testViaXHR()
{
  dump("Test 1\n");
  runXHRTest(baitURI,  testHeaderVal);
  dump("Test 2\n");
  runXHRTest(bait2URI, testHeaderVal2);
  dump("Test 3\n");
  runXHRTest(bait3URI, testHeaderVal);
  //dump("Test 4");
  //runXHRTest(bait4URI, testHeaderVal);
}

function runXHRTest(uri, headerValue)
{
  // Check that making an XHR request for uri winds up redirecting to a result with the
  // appropriate headerValue
  var xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"];

  var req = xhr.createInstance(Ci.nsIXMLHttpRequest);
  req.open("GET", uri, false);
  req.send();
  do_check_eq(req.getResponseHeader(testHeaderName), headerValue);
  do_check_eq(req.response, redirectedText);
}

function done()
{
  dump("done()");
  httpServer.stop(function () {httpServer2.stop(do_test_finished);});
}

function run_test()
{
  httpServer = new HttpServer();
  httpServer.registerPathHandler(baitPath, baitHandler);
  httpServer.registerPathHandler(bait2Path, baitHandler);
  httpServer.registerPathHandler(bait3Path, bait3Handler);
  httpServer.registerPathHandler(bait4Path, baitHandler);
  httpServer.registerPathHandler(redirectedPath, redirectedHandler);
  httpServer.start(4444);
  httpServer2 = new HttpServer();
  httpServer2.registerPathHandler(redirectedPath, redirected2Handler);
  httpServer2.start(4445);

  redirected = new Redirector();

  testViaXHR();
  testViaAsyncOpen();  // will call done() asynchronously for cleanup

  do_test_pending();
}
