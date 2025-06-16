import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

interface ScrapedData {
  title: string;
  mrp: number;
  sale_price: number;
  discount: string;
  condition: string;
  storage: string;
  ram?: string;
  color?: string;
  image_url?: string;
  is_out_of_stock?: boolean;
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Initialize Supabase client with service role key for admin access
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get all products that need updating (last checked more than 1 hour ago)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    const { data: products, error: fetchError } = await supabase
      .from('products')
      .select('*')
      .lt('last_checked', oneHourAgo);

    if (fetchError) {
      throw fetchError;
    }

    if (!products || products.length === 0) {
      console.log('No products need updating at this time');
      return new Response(
        JSON.stringify({ message: 'No products need updating', updated: 0 }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`Found ${products.length} products to update`);

    let updatedCount = 0;
    const errors: string[] = [];

    // Update each product
    for (const product of products) {
      try {
        console.log(`Updating product: ${product.title}`);
        const scrapedData = await scrapeProduct(product.url);
        
        // Get current price history
        const currentPriceHistory = product.price_history || [];
        const lastPrice = currentPriceHistory.length > 0 
          ? currentPriceHistory[currentPriceHistory.length - 1].price 
          : 0;

        // Only add to price history if price changed (for in-stock products)
        let newPriceHistory = currentPriceHistory;
        let priceChanged = false;

        if (!scrapedData.is_out_of_stock && lastPrice !== scrapedData.sale_price) {
          newPriceHistory = [
            ...currentPriceHistory,
            {
              price: scrapedData.sale_price,
              checked_at: new Date().toISOString()
            }
          ];
          priceChanged = true;
          console.log(`Price changed for ${product.title}: ₹${lastPrice} → ₹${scrapedData.sale_price}`);
        }

        // Check for stock status change
        const stockStatusChanged = product.is_out_of_stock !== scrapedData.is_out_of_stock;
        if (stockStatusChanged) {
          console.log(`Stock status changed for ${product.title}: ${product.is_out_of_stock ? 'Out of Stock' : 'In Stock'} → ${scrapedData.is_out_of_stock ? 'Out of Stock' : 'In Stock'}`);
        }

        // Update product in database
        const { error: updateError } = await supabase
          .from('products')
          .update({
            title: scrapedData.title,
            mrp: scrapedData.mrp,
            sale_price: scrapedData.sale_price,
            discount: scrapedData.discount,
            condition: scrapedData.condition,
            storage: scrapedData.storage,
            ram: scrapedData.ram || '',
            color: scrapedData.color || '',
            image_url: scrapedData.image_url,
            is_out_of_stock: scrapedData.is_out_of_stock || false,
            price_history: newPriceHistory,
            last_checked: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', product.id);

        if (updateError) {
          errors.push(`Failed to update product ${product.id}: ${updateError.message}`);
        } else {
          updatedCount++;
          console.log(`✅ Updated product: ${product.title}`);
          
          // Check for price alerts if price dropped (only for in-stock products)
          if (!scrapedData.is_out_of_stock && priceChanged && lastPrice > scrapedData.sale_price) {
            console.log(`Price dropped for ${product.title}, checking alerts...`);
            await checkPriceAlerts(supabase, product, scrapedData.sale_price);
          }

          // Send stock alert if product came back in stock
          if (stockStatusChanged && !scrapedData.is_out_of_stock && product.is_out_of_stock) {
            console.log(`Product back in stock: ${product.title}, sending alert...`);
            await sendStockAlert(supabase, product, scrapedData);
          }
        }

        // Add delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.error(`Failed to update product ${product.id}:`, error);
        errors.push(`Failed to scrape product ${product.id}: ${error.message}`);
      }
    }

    const message = `Automatic price update completed: ${updatedCount}/${products.length} products updated`;
    console.log(message);

    return new Response(
      JSON.stringify({ 
        message,
        updated: updatedCount,
        total: products.length,
        errors: errors.length > 0 ? errors : undefined
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error in automatic price update:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function sendStockAlert(supabase: any, product: any, scrapedData: ScrapedData) {
  try {
    // Get user email
    const { data: user } = await supabase.auth.admin.getUserById(product.user_id);
    
    if (!user?.user?.email) {
      console.error('User email not found for stock alert');
      return;
    }

    await sendStockAlertEmail(user.user.email, product, scrapedData);
    console.log(`✅ Stock alert sent to ${user.user.email} for product: ${scrapedData.title}`);
  } catch (error) {
    console.error('Error sending stock alert:', error);
  }
}

async function sendStockAlertEmail(userEmail: string, product: any, scrapedData: ScrapedData) {
  // Get Resend API key from environment
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  
  if (!resendApiKey) {
    console.error('❌ RESEND_API_KEY not found in environment variables');
    console.log('📧 EMAIL SIMULATION - Stock alert for:', userEmail);
    console.log('📦 Product:', scrapedData.title);
    console.log('💰 Price:', `₹${scrapedData.sale_price.toLocaleString()}`);
    console.log('📊 Status: Back in Stock');
    return;
  }

  const fromEmail = 'onboarding@resend.dev';

  const emailContent = {
    from: `PriceTracker <${fromEmail}>`,
    to: [userEmail],
    subject: `🎉 Back in Stock: ${scrapedData.title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
        <div style="background-color: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: bold;">🎯 PriceTracker</h1>
            <p style="color: #64748b; margin: 10px 0 0 0; font-size: 16px;">Stock Alert Notification</p>
          </div>

          <!-- Stock Alert -->
          <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 30px;">
            <h2 style="margin: 0 0 10px 0; font-size: 24px;">🎉 Great News! Back in Stock!</h2>
            <p style="margin: 0; font-size: 16px; opacity: 0.9;">The product you've been tracking is now available for purchase</p>
          </div>

          <!-- Product Details -->
          <div style="background-color: #f1f5f9; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
            <h3 style="color: #1e293b; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">${scrapedData.title}</h3>
            
            <div style="display: grid; gap: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Status:</span>
                <span style="color: #059669; font-weight: bold; font-size: 16px;">✅ In Stock</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Current Price:</span>
                <span style="color: #059669; font-size: 20px; font-weight: bold;">₹${scrapedData.sale_price.toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Condition:</span>
                <span style="color: #1e293b; font-weight: 500;">${scrapedData.condition}</span>
              </div>
              
              ${scrapedData.storage ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0;">
                <span style="color: #64748b; font-weight: 500;">Storage:</span>
                <span style="color: #1e293b; font-weight: 500;">${scrapedData.storage}</span>
              </div>
              ` : ''}
            </div>

            <div style="background-color: #dcfce7; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin-top: 15px;">
              <p style="margin: 0; color: #166534; font-weight: 600; text-align: center;">
                📦 Don't wait too long - popular items can go out of stock quickly!
              </p>
            </div>
          </div>

          <!-- Action Buttons -->
          <div style="text-align: center; margin-bottom: 25px;">
            <a href="${product.url}" 
               style="display: inline-block; background-color: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              🛒 Buy Now on Cashify
            </a>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
            <p style="color: #64748b; font-size: 14px; margin: 0 0 10px 0;">
              Happy shopping! 🛍️ We'll continue monitoring this product for you.
            </p>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              You received this email because you're tracking this product on PriceTracker.
            </p>
          </div>
        </div>
      </div>
    `
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailContent),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log('✅ Stock alert email sent successfully via Resend:', result.id);
    
  } catch (error) {
    console.error('❌ Failed to send stock alert email via Resend:', error);
    throw error;
  }
}

async function checkPriceAlerts(supabase: any, product: any, newPrice: number) {
  try {
    // Get active alerts for this product where target price is met
    const { data: alerts, error } = await supabase
      .from('price_alerts')
      .select('*')
      .eq('product_id', product.id)
      .eq('is_active', true)
      .gte('target_price', newPrice);

    if (error) {
      console.error('Error fetching alerts:', error);
      return;
    }

    if (!alerts || alerts.length === 0) {
      console.log(`No active alerts triggered for ${product.title}`);
      return;
    }

    console.log(`Found ${alerts.length} triggered alerts for ${product.title}`);

    // Send email notifications for triggered alerts
    for (const alert of alerts) {
      try {
        // Get user email
        const { data: user } = await supabase.auth.admin.getUserById(alert.user_id);
        
        if (user?.user?.email) {
          await sendPriceTriggeredEmail(user.user.email, product, alert, newPrice);
          console.log(`✅ Price alert email sent to ${user.user.email}`);
        }
        
        // Deactivate the alert after sending notification
        await supabase
          .from('price_alerts')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', alert.id);
          
      } catch (emailError) {
        console.error('Error sending price alert email:', emailError);
      }
    }
  } catch (error) {
    console.error('Error checking price alerts:', error);
  }
}

async function sendPriceTriggeredEmail(userEmail: string, product: any, alert: any, newPrice: number) {
  // Get Resend API key from environment
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  
  if (!resendApiKey) {
    console.error('❌ RESEND_API_KEY not found in environment variables');
    console.log('📧 EMAIL SIMULATION - Price alert triggered for:', userEmail);
    console.log('📦 Product:', product.title);
    console.log('🎯 Target Price:', `₹${alert.target_price.toLocaleString()}`);
    console.log('💰 New Price:', `₹${newPrice.toLocaleString()}`);
    return;
  }

  const fromEmail = 'onboarding@resend.dev';
  const savings = alert.target_price - newPrice;

  const emailContent = {
    from: `PriceTracker <${fromEmail}>`,
    to: [userEmail],
    subject: `🎉 Price Alert Triggered: ${product.title} - Now ₹${newPrice.toLocaleString()}!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
        <div style="background-color: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: bold;">🎯 PriceTracker</h1>
            <p style="color: #64748b; margin: 10px 0 0 0; font-size: 16px;">Your Price Alert Has Been Triggered!</p>
          </div>

          <!-- Alert Triggered -->
          <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 30px;">
            <h2 style="margin: 0 0 10px 0; font-size: 24px;">🎉 Great News! Price Dropped!</h2>
            <p style="margin: 0; font-size: 16px; opacity: 0.9;">Your target price has been reached - time to buy!</p>
          </div>

          <!-- Price Comparison -->
          <div style="background-color: #f1f5f9; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
            <h3 style="color: #1e293b; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">${product.title}</h3>
            
            <div style="display: grid; gap: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">New Price:</span>
                <span style="color: #059669; font-size: 24px; font-weight: bold;">₹${newPrice.toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Your Target:</span>
                <span style="color: #8b5cf6; font-size: 18px; font-weight: bold;">₹${alert.target_price.toLocaleString()}</span>
              </div>
              
              ${savings > 0 ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Extra Savings:</span>
                <span style="color: #dc2626; font-weight: bold;">₹${savings.toLocaleString()} below target!</span>
              </div>
              ` : ''}
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Condition:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.condition}</span>
              </div>
              
              ${product.storage ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0;">
                <span style="color: #64748b; font-weight: 500;">Storage:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.storage}</span>
              </div>
              ` : ''}
            </div>

            <div style="background-color: #dcfce7; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin-top: 15px;">
              <p style="margin: 0; color: #166534; font-weight: 600; text-align: center;">
                🎯 Perfect! The price has dropped ${savings > 0 ? `₹${savings.toLocaleString()} below` : 'to'} your target price!
              </p>
            </div>
          </div>

          <!-- Urgency Message -->
          <div style="background-color: #fef3c7; border: 1px solid #fbbf24; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
            <h4 style="color: #92400e; margin: 0 0 12px 0; font-size: 18px;">⏰ Act Fast!</h4>
            <p style="color: #92400e; margin: 0; line-height: 1.6;">
              Great deals don't last long! This price might go back up soon. 
              Consider purchasing now to secure this amazing deal.
            </p>
          </div>

          <!-- Action Buttons -->
          <div style="text-align: center; margin-bottom: 25px;">
            <a href="${product.url}" 
               style="display: inline-block; background-color: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              🛒 Buy Now on Cashify
            </a>
          </div>

          <!-- Alert Status -->
          <div style="background-color: #f3f4f6; border: 1px solid #d1d5db; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
            <p style="margin: 0; color: #374151; text-align: center; font-weight: 500;">
              📋 This price alert has been automatically deactivated. Set up a new alert if you want to continue monitoring this product.
            </p>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
            <p style="color: #64748b; font-size: 14px; margin: 0 0 10px 0;">
              Happy shopping! 🛍️ Thanks for using PriceTracker.
            </p>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              You received this email because your price alert was triggered.
            </p>
          </div>
        </div>
      </div>
    `
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailContent),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log('✅ Price triggered email sent successfully via Resend:', result.id);
    
  } catch (error) {
    console.error('❌ Failed to send price triggered email via Resend:', error);
    throw error;
  }
}

async function scrapeProduct(url: string): Promise<ScrapedData> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();

    // Check for out of stock first
    const outOfStockPattern = /<h6[^>]*class="[^"]*subtitle1[^"]*text-center[^"]*py-2[^"]*px-1[^"]*sm:py-3[^"]*w-full[^"]*bg-primary\/70[^"]*text-primary-text-contrast[^"]*"[^>]*>Out of Stock<\/h6>/i;
    const isOutOfStock = outOfStockPattern.test(html);

    // Extract title from h1 tag or page title
    let title = '';
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
      title = h1Match[1].trim();
    } else {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'Unknown Product';
    }

    // Extract MRP using the specific element you provided
    let mrp = 0;
    const mrpPattern = /<h6[^>]*class="[^"]*subtitle1[^"]*line-through[^"]*text-surface-text[^"]*"[^>]*>₹([0-9,]+)<\/h6>/i;
    const mrpMatch = html.match(mrpPattern);
    if (mrpMatch) {
      mrp = parseInt(mrpMatch[1].replace(/,/g, ''));
    }

    // Fallback MRP patterns if the specific one doesn't match
    if (!mrp) {
      const fallbackMrpPatterns = [
        /<h6[^>]*line-through[^>]*>₹([0-9,]+)<\/h6>/gi,
        /<[^>]*line-through[^>]*>₹([0-9,]+)<\/[^>]*>/gi,
        /₹([0-9,]+)[^0-9]*<\/del>/gi,
        /₹([0-9,]+)[^0-9]*<\/s>/gi,
      ];

      for (const pattern of fallbackMrpPatterns) {
        const match = pattern.exec(html);
        if (match) {
          const price = parseInt(match[1].replace(/,/g, ''));
          if (price > 0 && price < 2000000) {
            mrp = price;
            break;
          }
        }
      }
    }

    // Extract sale price using the specific element you provided
    let sale_price = 0;
    if (!isOutOfStock) {
      const salePricePattern = /<span[^>]*class="[^"]*h1[^"]*"[^>]*itemprop="price"[^>]*>₹([0-9,]+)<\/span>/i;
      const salePriceMatch = html.match(salePricePattern);
      if (salePriceMatch) {
        sale_price = parseInt(salePriceMatch[1].replace(/,/g, ''));
      }

      // Fallback sale price patterns if the specific one doesn't match
      if (!sale_price) {
        const fallbackSalePricePatterns = [
          /<span[^>]*itemprop="price"[^>]*>₹([0-9,]+)<\/span>/gi,
          /<span[^>]*class="[^"]*h1[^"]*"[^>]*>₹([0-9,]+)<\/span>/gi,
          /"price"[^:]*:\s*"?₹?\s*([0-9,]+)"?/gi,
          /class="[^"]*price[^"]*"[^>]*>₹\s*([0-9,]+)/gi,
        ];

        for (const pattern of fallbackSalePricePatterns) {
          const match = pattern.exec(html);
          if (match) {
            const price = parseInt(match[1].replace(/,/g, ''));
            if (price > 0 && price < 2000000) {
              sale_price = price;
              break;
            }
          }
        }
      }
    }

    // Extract discount using the specific element you provided
    let discount = '0%';
    if (!isOutOfStock) {
      const discountPattern = /<div[^>]*class="[^"]*h1[^"]*text-error[^"]*"[^>]*>-<!--\s*-->([0-9]+)<!--\s*-->%<\/div>/i;
      const discountMatch = html.match(discountPattern);
      if (discountMatch) {
        discount = `${discountMatch[1]}%`;
      }

      // Fallback discount patterns if the specific one doesn't match
      if (discount === '0%') {
        const fallbackDiscountPatterns = [
          /<div[^>]*text-error[^>]*>-[^0-9]*([0-9]+)[^0-9]*%<\/div>/gi,
          /([0-9]+)%\s*OFF/gi,
          /([0-9]+)%\s*off/gi,
          /-([0-9]+)%/gi,
        ];

        for (const pattern of fallbackDiscountPatterns) {
          const match = pattern.exec(html);
          if (match) {
            discount = `${match[1]}%`;
            break;
          }
        }
      }

      // If no discount found but we have both prices, calculate it
      if (discount === '0%' && mrp > 0 && sale_price > 0 && mrp > sale_price) {
        const discountPercent = Math.round(((mrp - sale_price) / mrp) * 100);
        discount = `${discountPercent}%`;
      }
    }

    // Extract detailed product information from the body element
    let condition = 'Good'; // Default
    let storage = '';
    let ram = '';
    let color = '';

    // Look for the specific body element pattern you provided
    const bodyPattern = /<div[^>]*class="[^"]*body2[^"]*mb-2[^"]*text-surface-text[^"]*"[^>]*>([^<]+)<\/div>/i;
    const bodyMatch = html.match(bodyPattern);
    
    if (bodyMatch) {
      const bodyText = bodyMatch[1].trim();
      
      // Parse the body text: "Cashify Warranty, Fair, 6 GB / 128 GB, Pacific Blue"
      const parts = bodyText.split(',').map(part => part.trim());
      
      if (parts.length >= 2) {
        // Second part is usually the condition
        const conditionPart = parts[1];
        if (['Fair', 'Good', 'Excellent', 'Superb'].some(c => conditionPart.toLowerCase().includes(c.toLowerCase()))) {
          condition = conditionPart;
        }
      }
      
      if (parts.length >= 3) {
        // Third part is usually RAM/Storage: "6 GB / 128 GB"
        const storagePart = parts[2];
        const storageMatch = storagePart.match(/(\d+\s*GB)\s*\/\s*(\d+\s*[GT]B)/i);
        if (storageMatch) {
          ram = storageMatch[1].trim();
          storage = storageMatch[2].trim();
        } else {
          // Fallback: look for any storage pattern
          const fallbackStorageMatch = storagePart.match(/(\d+\s*[GT]B)/i);
          if (fallbackStorageMatch) {
            storage = fallbackStorageMatch[1].trim();
          }
        }
      }
      
      if (parts.length >= 4) {
        // Fourth part is usually the color
        color = parts[3];
      }
    }

    // Fallback condition extraction if not found in body
    if (condition === 'Good') {
      const conditionPatterns = [
        /Cashify Warranty[^,]*,\s*([^,]+)/i,
        /"condition"[^:]*:\s*"([^"]+)"/i,
        /(Fair|Good|Excellent|Superb)/gi,
        /Condition[^>]*>([^<]+)</i,
        /Grade[^>]*>([^<]+)</i,
      ];

      for (const pattern of conditionPatterns) {
        const match = html.match(pattern);
        if (match) {
          condition = match[1].trim();
          // Normalize condition values
          if (condition.toLowerCase().includes('fair')) condition = 'Fair';
          else if (condition.toLowerCase().includes('good')) condition = 'Good';
          else if (condition.toLowerCase().includes('excellent')) condition = 'Excellent';
          else if (condition.toLowerCase().includes('superb')) condition = 'Superb';
          break;
        }
      }
    }

    // Fallback storage extraction if not found in body
    if (!storage) {
      const storagePatterns = [
        /(\d+\s*GB)/gi,
        /(\d+\s*TB)/gi,
        /Storage[^>]*>([^<]*\d+[^<]*[GT]B[^<]*)</i,
        /Memory[^>]*>([^<]*\d+[^<]*[GT]B[^<]*)</i
      ];

      // First try to extract from title
      for (const pattern of storagePatterns) {
        const matches = title.match(pattern);
        if (matches) {
          storage = matches[0].trim();
          break;
        }
      }

      // If not found in title, search in HTML
      if (!storage) {
        for (const pattern of storagePatterns) {
          const matches = html.match(pattern);
          if (matches) {
            const storageValues = matches.map(m => m.trim()).filter(s => s.length < 20);
            if (storageValues.length > 0) {
              storage = storageValues[0];
              break;
            }
          }
        }
      }
    }

    // Extract image URL
    let image_url = '';
    const imagePatterns = [
      /<img[^>]+src=["']([^"']*product[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i,
      /<img[^>]+src=["']([^"']*mobile[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i,
      /<img[^>]+src=["']([^"']*phone[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i,
      /<img[^>]+src=["']([^"']*iphone[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i,
      /<img[^>]+src=["']([^"']*\.(?:jpg|jpeg|png|webp))[^"']*["'][^>]*alt="[^"]*product[^"]*"/i
    ];

    for (const pattern of imagePatterns) {
      const match = html.match(pattern);
      if (match) {
        image_url = match[1];
        if (!image_url.startsWith('http')) {
          image_url = new URL(image_url, url).href;
        }
        break;
      }
    }

    // Clean up title
    title = title.replace(/\s*-\s*Cashify.*$/i, '').replace(/\s+/g, ' ').trim();
    if (title.length > 100) {
      title = title.substring(0, 100) + '...';
    }

    // Combine RAM and storage for the storage field if both are available
    let finalStorage = storage;
    if (ram && storage) {
      finalStorage = `${ram} / ${storage}`;
    } else if (ram && !storage) {
      finalStorage = ram;
    }

    // For out of stock products, use fallback prices if needed
    if (isOutOfStock) {
      if (!mrp && !sale_price) {
        mrp = 50000;
        sale_price = 45000;
      } else if (!sale_price) {
        sale_price = mrp || 45000;
      } else if (!mrp) {
        mrp = sale_price + 5000;
      }
    }

    // Ensure we have valid data
    if (!mrp && !sale_price) {
      throw new Error('Could not extract price information from the page');
    }

    return {
      title: title || 'Cashify Product',
      mrp: mrp || sale_price || 50000,
      sale_price: sale_price || mrp || 45000,
      discount,
      condition,
      storage: finalStorage || '128GB',
      ram,
      color,
      image_url: image_url || undefined,
      is_out_of_stock: isOutOfStock
    };

  } catch (error) {
    console.error('Scraping error:', error);
    throw error;
  }
}